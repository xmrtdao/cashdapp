// One event, several people, one lead.
//
// Every case here is one that has actually produced two bookings for one
// wedding: a reply that arrived as a brand new lead, a second sender on the
// same thread, a duplicate lead that had to be resolved, a person who belongs
// to somebody else's event, and two leads that both claimed the same booking.
//
// The rule under test is that a lead is an EVENT, not a sender. Two people
// replying about the same wedding must end up on one lead, and two leads
// claiming the same booking must be refused rather than merged.
//
// Runs against the throwaway test database (see tests/_run.mjs).

import pg from 'pg';
import {
  captureInboundEmail,
  attachContact,
  ensureLeadStageSchema,
  seedStages,
} from '../lib/pfp-lead-stages.mjs';
import { mergeLeadInto } from '../lib/pfp-lead-merge.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const DB = process.env.LOCAL_DATABASE_URL
  || process.env.LOCAL_PG_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite_test';

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = (sql, params) => client.query(sql, params);

const countLeads = async () => (await q('SELECT count(*)::int AS n FROM public.pfp_leads')).rows[0].n;
const countContacts = async () => (await q('SELECT count(*)::int AS n FROM public.pfp_contacts')).rows[0].n;

// The lead the same-thread section built. Hoisted so the next section can
// assert that a contact does not move away from it.
let threadLead = null;

async function makeLead(email, name, notes = 'test fixture') {
  const r = await q(
    `INSERT INTO public.pfp_leads
       (contact_name, contact_email, source, source_code, stage, stage_entered_at, status, notes)
     VALUES ($1,$2,'inbound email','email_inquiry','new',NOW(),'NEW',$3)
     RETURNING id`,
    [name, email, notes]);
  return r.rows[0].id;
}

// ── fixtures ────────────────────────────────────────────────────────────────
await ensureLeadStageSchema(q);
await seedStages(q);
// Order matters: pfp_leads.primary_contact_id points at a contact, so the
// leads have to let go of their primary before the contacts are deleted.
await q('UPDATE public.pfp_leads SET primary_contact_id = NULL');
await q('DELETE FROM public.pfp_inbound_emails');
await q('DELETE FROM public.pfp_bookings');
await q('DELETE FROM public.pfp_quotes');
await q('DELETE FROM public.pfp_lead_stage_history');
await q('DELETE FROM public.pfp_contacts');
await q('DELETE FROM public.pfp_leads');
await q('DELETE FROM public.pfp_internal_addresses');
await q(
  `INSERT INTO public.pfp_internal_addresses (email, reason)
   VALUES ('bookings@partyfavorphoto.com','Studio bookings mailbox. Not a client.')`);

section('the studio emailing itself is never a lead');
{
  const before = await countLeads();
  const r = await captureInboundEmail(q, {
    from_email: 'bookings@partyfavorphoto.com',
    subject: 'Re: Designs for 11/8 Wedding in Berryville, VA',
    snippet: 'Checking the designs are attached for you.',
    message_id: '<internal-1@example>',
  });
  check('it is recorded as internal', r.outcome === 'internal_ignored', JSON.stringify(r));
  check('no lead is created', await countLeads() === before, await countLeads());
  const row = (await q(
    'SELECT lead_id, outcome FROM public.pfp_inbound_emails WHERE message_id=$1', ['<internal-1@example>'])).rows[0];
  check('the message is still on file', !!row);
  check('with no lead attached', row && row.lead_id === null, JSON.stringify(row));
}

section('a reply from someone we already know goes to their lead');
{
  const lead = await makeLead('natalia@example.com', 'Natalia Jaffee');
  await attachContact(q, {
    lead_id: lead, email: 'natalia@example.com', name: 'Natalia Jaffee',
    role: 'primary client', is_primary: true,
  });
  const before = await countLeads();
  const r = await captureInboundEmail(q, {
    from_email: 'natalia@example.com',
    subject: 'Re: Designs for 11/8 Wedding in Berryville, VA',
    snippet: 'The cake is booked. See you in November.',
    message_id: '<known-1@example>',
  });
  check('it is a reply, not a new lead', r.outcome === 'contact_reply', JSON.stringify(r));
  check('it lands on their lead', r.lead_id === lead, r.lead_id);
  check('no second lead appears', await countLeads() === before, await countLeads());
}

section('a second person on the same thread joins the same event');
{
  // A subject of its own: the thread key is the normalised subject, so two
  // sections sharing one would be the same event by design.
  const SUBJECT = 'Re: Sweet Sixteen in Arlington, VA';
  const first = await captureInboundEmail(q, {
    from_email: 'jonathan@example.com',
    subject: SUBJECT,
    snippet: 'We love the package you sent over.',
    message_id: '<thread-1@example>',
  });
  threadLead = first.lead_id;
  check('the first sender gets a lead', first.outcome === 'lead_created' && !!first.lead_id, JSON.stringify(first));

  const leadsBefore = await countLeads();
  const second = await captureInboundEmail(q, {
    from_email: 'planner@example.com',
    subject: SUBJECT,
    snippet: 'Adding the ceremony details from our side.',
    message_id: '<thread-2@example>',
  });
  check('the second sender is attached, not given a lead',
    second.outcome === 'contact_attached', JSON.stringify(second));
  check('to the same lead', second.lead_id === first.lead_id, `${second.lead_id} vs ${first.lead_id}`);
  check('no second lead is created', await countLeads() === leadsBefore, await countLeads());

  const c = (await q(
    'SELECT lead_id, is_primary FROM public.pfp_contacts WHERE lower(email)=$1', ['planner@example.com'])).rows[0];
  check('they are a contact on that lead', !!c && c.lead_id === first.lead_id, JSON.stringify(c));
  check('and not the primary', !!c && c.is_primary === false, JSON.stringify(c));
}

section('a merged duplicate resolves to the survivor');
{
  const duplicate = await makeLead('groom@example.com', 'Jonathan Knapp');
  await attachContact(q, {
    lead_id: duplicate, email: 'groom@example.com', name: 'Jonathan Knapp',
    role: 'primary client', is_primary: true,
  });
  const survivor = await makeLead('survivor@example.com', 'Natalia Jaffee');
  const merged = await mergeLeadInto(q, {
    duplicate_lead_id: duplicate, target_lead_id: survivor, actor: 'test',
  });
  check('the merge succeeds', merged.ok === true, JSON.stringify(merged));

  const moved = (await q(
    'SELECT lead_id FROM public.pfp_contacts WHERE lower(email)=$1', ['groom@example.com'])).rows[0];
  check('the contact followed the person to the survivor', moved && moved.lead_id === survivor, JSON.stringify(moved));

  const leadsBefore = await countLeads();
  const r = await captureInboundEmail(q, {
    from_email: 'groom@example.com',
    subject: 'Re: Designs for 11/8 Wedding in Berryville, VA',
    snippet: 'One more question about the timeline.',
    message_id: '<merged-1@example>',
  });
  check('their next reply lands on the survivor', r.lead_id === survivor, JSON.stringify(r));
  check('and not on the merged row', r.lead_id !== duplicate);
  check('and no lead is created for them again', await countLeads() === leadsBefore, await countLeads());
}

section('a person already on another event is not moved');
{
  const other = await makeLead('other@example.com', 'Other Event');
  const r = await attachContact(q, {
    lead_id: other, email: 'planner@example.com', name: 'Planner',
  });
  check('the attach is refused', r.ok === false, JSON.stringify(r));
  check('and says where the person belongs',
    typeof r.error === 'string' && /already attached to lead/.test(r.error), r.error);
  const c = (await q(
    'SELECT lead_id FROM public.pfp_contacts WHERE lower(email)=$1', ['planner@example.com'])).rows[0];
  check('the contact did not move', c && c.lead_id === threadLead, JSON.stringify(c));
}

section('two bookings for one event is refused, not merged');
{
  const a = await makeLead('dup@example.com', 'Dup Lead');
  const b = await makeLead('keep@example.com', 'Survivor Lead');
  await q(
    `INSERT INTO public.pfp_bookings (lead_id, client_name, client_email, event_name, event_date)
     VALUES ($1,'Dup','dup@example.com','Wedding','2026-11-08')`, [a]);
  await q(
    `INSERT INTO public.pfp_bookings (lead_id, client_name, client_email, event_name, event_date)
     VALUES ($1,'Keep','keep@example.com','Wedding','2026-11-08')`, [b]);

  const r = await mergeLeadInto(q, { duplicate_lead_id: a, target_lead_id: b, actor: 'test' });
  check('the merge is refused', r.ok === false, JSON.stringify(r));
  check('and names the conflict',
    typeof r.error === 'string' && /two bookings for one event/.test(r.error), r.error);
  const still = (await q('SELECT merged_into_lead_id FROM public.pfp_leads WHERE id=$1', [a])).rows[0];
  check('neither lead moved', still && still.merged_into_lead_id === null, JSON.stringify(still));
  const bookings = (await q(
    'SELECT lead_id FROM public.pfp_bookings WHERE lead_id = ANY($1::uuid[]) ORDER BY lead_id', [[a, b]])).rows;
  check('both bookings are still where they were', bookings.length === 2, JSON.stringify(bookings));
}

section('the same message twice is one lead, not two');
{
  // Its own subject, so this is a new lead rather than another sender on a
  // thread that already exists.
  const before = await countLeads();
  const first = await captureInboundEmail(q, {
    from_email: 'once@example.com',
    subject: 'Re: Quinceanera Shoot in Woodbridge, VA',
    snippet: 'Sending this once.',
    message_id: '<dup-msg@example>',
  });
  check('the first capture creates a lead', first.outcome === 'lead_created', JSON.stringify(first));
  const second = await captureInboundEmail(q, {
    from_email: 'once@example.com',
    subject: 'Re: Quinceanera Shoot in Woodbridge, VA',
    snippet: 'Sending this once.',
    message_id: '<dup-msg@example>',
  });
  check('the second capture is a duplicate', second.duplicate === true, JSON.stringify(second));
  check('and creates no second lead', await countLeads() === before + 1, await countLeads());
  const rows = (await q(
    'SELECT count(*)::int AS n FROM public.pfp_inbound_emails WHERE message_id=$1', ['<dup-msg@example>'])).rows[0];
  check('the message is on file once', rows.n === 1, JSON.stringify(rows));
}

await client.end();
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
