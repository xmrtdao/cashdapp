/**
 * relay/lib/pfp-lead-stages.mjs — the lead lifecycle.
 *
 * THE MODEL, AND WHERE IT DEPARTS FROM THE ONE DESCRIBED
 * ------------------------------------------------------
 * A lead is created the moment an email response arrives - campaign or organic,
 * it makes no difference, the person replied. Then:
 *
 *   new          30 days   a reply in, nothing sent yet
 *   negotiating  60 days   a contract has gone out
 *   booked                payment received
 *   stale                 the clock ran out with no response
 *   lost                  declined, unreachable, or said no
 *
 * Four changes to the version as first described, each because the original
 * would have lost money or produced data nobody could act on.
 *
 * 1. TIME TO EVENT OVERRIDES THE CLOCK.
 *    The proposal time-boxed every stage at 30/60 days. For an events business
 *    the governing clock is the event date, not the age of the conversation: a
 *    wedding on 3 May quoted in January is a completely different proposition
 *    from the same wedding quoted in April. A lead whose event is inside the
 *    guard window is never auto-expired - it is flagged for a human, because
 *    expiring a lead with an event next week throws away booked work.
 *
 * 2. STALE AND LOST ARE NOT THE SAME BRANCH.
 *    "Turns stale or lost" treats a dormant lead and a dead one as one thing.
 *    `stale` is still warm and belongs back in the working set; `lost` is out.
 *    They need separate transitions, and `lost` REQUIRES A REASON - a lost bucket
 *    with no reason is a trash can, and the reason codes are where the actual
 *    business intelligence lives ("too expensive", "booked elsewhere", "no
 *    reply", "wrong service area").
 *
 * 3. PAYMENT CAN ARRIVE FROM ANY STAGE.
 *    The described flow implies contract -> negotiating -> payment. But a client
 *    can pay from a Stripe link having never seen a contract, and
 *    `pfp-checkout.mjs` already creates bookings that way. `booked` is therefore
 *    reachable from everywhere, not only from `negotiating`.
 *
 * 4. A STALE LEAD CAN COME BACK.
 *    Someone who goes quiet for 40 days and then replies is not lost. Any inbound
 *    email resurrects a stale or lost lead into `new`, with the gap preserved in
 *    the history rather than overwritten.
 */

import { LEAD_STAGE_CODES } from './pfp-lead-stage-codes.mjs';
import { suppress } from './pfp-campaign-log.mjs';

export const STAGES = Object.freeze([
  Object.freeze({
    code: 'new', label: 'New lead', category: 'open', order: 1, max_days: 30,
    entry: 'An email response arrives in the inbox, from the campaign or organically.',
    exit: 'A contract is sent (-> negotiating), the client declines (-> lost), or 30 days pass with no response (-> stale).',
    means: 'Somebody got in touch and we have not sent anything yet.',
    terminal: false,
  }),
  Object.freeze({
    code: 'negotiating', label: 'Contract sent', category: 'open', order: 2, max_days: 60,
    entry: 'A contract has been sent for a real booking.',
    exit: 'Payment received (-> booked), the client declines (-> lost), or 60 days pass with no payment (-> stale).',
    means: 'A contract is out and we are waiting on a decision.',
    terminal: false,
  }),
  Object.freeze({
    code: 'booked', label: 'Booked', category: 'won', order: 3, max_days: null,
    entry: 'Payment received. Reachable from ANY stage - a client can pay from a Stripe link without ever seeing a contract.',
    exit: 'The event is delivered, then closed out. Handled on the booking, not the lead.',
    means: 'Money in. The booth is committed.',
    terminal: false,
  }),
  Object.freeze({
    code: 'stale', label: 'Stale', category: 'dormant', order: 4, max_days: null,
    entry: 'The stage clock expired with no client response.',
    exit: 'A reply resurrects it (-> new). Otherwise it stays out of the working set until reviewed.',
    means: 'Went quiet. Not dead - dormant. Deliberately NOT terminal.',
    terminal: false,
  }),
  Object.freeze({
    code: 'lost', label: 'Lost', category: 'closed', order: 5, max_days: null,
    entry: 'The client declined, was unreachable, or the lead was disqualified. A reason is REQUIRED.',
    exit: 'A reply resurrects it (-> new).',
    means: 'Out. With a recorded reason.',
    terminal: false,
  }),
]);

/**
 * Legal transitions. Anything not listed needs `force: true`, which is recorded
 * in the history so an out-of-band move is always visible afterwards.
 */
export const TRANSITIONS = Object.freeze({
  new: Object.freeze(['negotiating', 'lost', 'stale', 'booked']),
  negotiating: Object.freeze(['booked', 'lost', 'stale', 'new']),
  booked: Object.freeze(['lost']),
  stale: Object.freeze(['new', 'lost', 'negotiating', 'booked']),
  lost: Object.freeze(['new', 'negotiating']),
});

/** Required when moving to `lost`. Free text is accepted; the common ones are listed. */
export const LOSS_REASONS = Object.freeze([
  'declined_by_client', 'booked_elsewhere', 'no_response',
  'unreachable', 'outside_service_area', 'price_too_high',
  'not_a_lead', 'duplicate', 'opted_out', 'other',
]);

/** How close an event may be before auto-expiry refuses to fire. */
export const EVENT_GUARD_DAYS = 14;

const stageByCode = new Map(STAGES.map((s) => [s.code, s]));

// ── schema ────────────────────────────────────────────────────────────────

export async function ensureLeadStageSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS public.pfp_lead_stages (
      code        text PRIMARY KEY,
      label       text NOT NULL,
      category    text NOT NULL,
      sort_order  integer NOT NULL,
      max_days    integer,
      terminal    boolean NOT NULL DEFAULT false,
      meaning     text,
      entry_rule  text,
      exit_rule   text
    )`);

  await query(`
    CREATE TABLE IF NOT EXISTS public.pfp_lead_stage_history (
      id          bigserial PRIMARY KEY,
      lead_id     uuid NOT NULL REFERENCES public.pfp_leads(id) ON DELETE CASCADE,
      from_stage  text,
      to_stage    text NOT NULL,
      reason      text,
      actor       text,
      forced      boolean NOT NULL DEFAULT false,
      note        text,
      created_at  timestamptz NOT NULL DEFAULT NOW()
    )`);

  // Inbound replies. Deduplicated on message_id so a client hitting refresh, or
  // an email gateway retrying a delivery, cannot create two leads from one
  // message.
  await query(`
    CREATE TABLE IF NOT EXISTS public.pfp_inbound_emails (
      id           bigserial PRIMARY KEY,
      message_id   text UNIQUE,
      sender_email text NOT NULL,
      sender_name  text,
      subject      text,
      snippet      text,
      lead_id      uuid REFERENCES public.pfp_leads(id) ON DELETE SET NULL,
      outcome      text,
      detail       text,
      received_at  timestamptz NOT NULL DEFAULT NOW()
    )`);

  // The timestamp columns must be timestamps, not text.
  //
  // stage_entered_at was always corrected here. first_reply_at and
  // contract_sent_at were not, and the code writes NOW() into both and then
  // reads one back as a timestamp - COALESCE(text, NOW()) has no common type,
  // so every reply from a known contact raised 42804 and left its inbound row
  // with outcome IS NULL. See migrations/pfp_012_lead_timestamp_types.sql.
  const timestampColumns = ['stage_entered_at', 'contract_sent_at', 'first_reply_at'];
  for (const col of ['stage', 'stage_entered_at', 'lost_reason', 'contract_sent_at', 'first_reply_at']) {
    const has = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='pfp_leads' AND column_name=$1`, [col]);
    if (!has.rows.length) {
      await query(`ALTER TABLE public.pfp_leads ADD COLUMN ${col} ${timestampColumns.includes(col) ? 'timestamptz' : 'text'}`);
    }
  }
  for (const col of timestampColumns) {
    await query(
      `ALTER TABLE public.pfp_leads ALTER COLUMN ${col} TYPE timestamptz USING ${col}::timestamptz`);
  }

  await query(
    `CREATE INDEX IF NOT EXISTS pfp_lead_history_lead_idx ON public.pfp_lead_stage_history (lead_id, created_at DESC)`);
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_lead_stage_idx ON public.pfp_leads (stage)`);
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_lead_expiry_idx ON public.pfp_leads (stage, stage_entered_at)
      WHERE stage IN ('new','negotiating')`);
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_inbound_sender_idx ON public.pfp_inbound_emails (lower(sender_email))`);

  // One event, several people. Runtime DDL mirrors
  // migrations/pfp_011_lead_contacts.sql so a fresh database has the model even
  // if the migration was never run; the migration is still the record of it.
  await query(
    `ALTER TABLE public.pfp_contacts ADD COLUMN IF NOT EXISTS lead_id uuid
       REFERENCES public.pfp_leads(id) ON DELETE SET NULL`);
  await query(
    `ALTER TABLE public.pfp_contacts ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false`);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS pfp_contacts_email_uniq
       ON public.pfp_contacts (lower(email)) WHERE email IS NOT NULL`);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS pfp_contacts_one_primary_per_lead
       ON public.pfp_contacts (lead_id) WHERE is_primary AND lead_id IS NOT NULL`);
  await query(
    `ALTER TABLE public.pfp_inbound_emails ADD COLUMN IF NOT EXISTS thread_key text`);
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_inbound_thread_idx
       ON public.pfp_inbound_emails (thread_key, received_at) WHERE thread_key IS NOT NULL`);
  await query(
    `ALTER TABLE public.pfp_leads ADD COLUMN IF NOT EXISTS merged_into_lead_id uuid
       REFERENCES public.pfp_leads(id) ON DELETE SET NULL`);
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_leads_merged_into_idx
       ON public.pfp_leads (merged_into_lead_id) WHERE merged_into_lead_id IS NOT NULL`);
  await query(`
    CREATE TABLE IF NOT EXISTS public.pfp_internal_addresses (
      email      text PRIMARY KEY,
      reason     text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
}

export async function seedStages(query) {
  for (const s of STAGES) {
    await query(
      `INSERT INTO public.pfp_lead_stages (code, label, category, sort_order, max_days, terminal, meaning, entry_rule, exit_rule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO UPDATE SET
         label=EXCLUDED.label, category=EXCLUDED.category, sort_order=EXCLUDED.sort_order,
         max_days=EXCLUDED.max_days, terminal=EXCLUDED.terminal, meaning=EXCLUDED.meaning,
         entry_rule=EXCLUDED.entry_rule, exit_rule=EXCLUDED.exit_rule`,
      [s.code, s.label, s.category, s.order, s.max_days, s.terminal, s.means, s.entry, s.exit]);
  }
}

// ── transitions ───────────────────────────────────────────────────────────

/**
 * Move a lead to a stage.
 *
 * Never throws for a missing or unknown lead - returns a refusal, because an
 * agent calling this needs to read what went wrong and correct itself.
 *
 * @param {(sql:string, params?:any[])=>Promise<any>} query
 * @param {{lead_id:string, to_stage:string, reason?:string, actor?:string,
 *          note?:string, force?:boolean}} args
 */
export async function advanceLeadStage(query, args) {
  const { lead_id, to_stage, reason, actor = 'system', note, force = false } = args;

  if (!lead_id) return { ok: false, error: 'lead_id is required' };
  const target = stageByCode.get(to_stage);
  if (!target) {
    return {
      ok: false,
      error: `unknown stage "${to_stage}". Known: ${[...stageByCode.keys()].join(', ')}`,
    };
  }

  const { rows } = await query(
    'SELECT id, stage, stage_entered_at, event_date, status FROM public.pfp_leads WHERE id = $1',
    [lead_id]);
  const lead = rows[0];
  if (!lead) return { ok: false, error: `no lead with id ${lead_id}` };

  const from = lead.stage ?? null;
  if (from === to_stage) {
    return { ok: true, unchanged: true, from, to: to_stage, lead_id,
             note: 'already in this stage; the clock is not restarted' };
  }

  if (from) {
    const allowed = TRANSITIONS[from] || [];
    if (!allowed.includes(to_stage) && !force) {
      return {
        ok: false,
        error: `illegal transition ${from} -> ${to_stage}. Allowed from ${from}: ${allowed.join(', ') || 'none'}. Pass force: true to override.`,
        from, to: to_stage, lead_id,
      };
    }
  }

  // A lost lead with no reason is a trash can. Required, not optional.
  if (to_stage === 'lost') {
    if (!reason) {
      return {
        ok: false,
        error: `moving to "lost" requires a reason. Known reasons: ${LOSS_REASONS.join(', ')}. ` +
          `"lost" with no reason tells you nothing about why the business is not growing.`,
        lead_id, from, to: to_stage,
      };
    }
    if (!LOSS_REASONS.includes(reason) && reason !== 'other') {
      return {
        ok: false,
        error: `unknown loss reason "${reason}". Known: ${LOSS_REASONS.join(', ')}, or "other".`,
        lead_id, from, to: to_stage,
      };
    }
  }

  await query(
    `UPDATE public.pfp_leads
        SET stage = $1, stage_entered_at = NOW(),
            lost_reason = CASE WHEN $1 = 'lost' THEN $2 ELSE NULL END,
            updated_at = NOW()
      WHERE id = $3`,
    [to_stage, to_stage === 'lost' ? reason : null, lead_id]);

  await query(
    `INSERT INTO public.pfp_lead_stage_history (lead_id, from_stage, to_stage, reason, actor, forced, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [lead_id, from, to_stage, reason ?? null, actor, Boolean(force), note ?? null]);

  return {
    ok: true, lead_id, from, to: to_stage, forced: Boolean(force) && from !== null,
    meaning: target.means,
    max_days: target.max_days,
  };
}

/**
 * Record that a contract went out. Moves new -> negotiating and stamps the
 * contract time, which is what the 60-day clock runs from.
 */
export async function markContractSent(query, args) {
  const { lead_id, contract_ref, actor = 'system' } = args;
  await query(
    'UPDATE public.pfp_leads SET contract_sent_at = NOW(), updated_at = NOW() WHERE id = $1',
    [lead_id]);
  return advanceLeadStage(query, {
    lead_id, to_stage: 'negotiating', actor,
    note: contract_ref ? `contract ${contract_ref}` : 'contract sent',
  });
}

/**
 * Payment received. Reachable from any stage on purpose - a client can pay from
 * a Stripe link having never seen a contract.
 */
export async function markPaymentReceived(query, args) {
  const { lead_id, amount_cents, payment_id, actor = 'system' } = args;
  const r = await advanceLeadStage(query, {
    lead_id, to_stage: 'booked', actor, force: true,
    note: amount_cents !== undefined
      ? `payment ${payment_id ?? ''} ${(amount_cents / 100).toFixed(2)}`
      : `payment ${payment_id ?? ''}`,
  });
  if (!r.ok) return r;
  await query(
    `UPDATE public.pfp_leads SET status = 'booked', updated_at = NOW() WHERE id = $1`, [lead_id]);
  return r;
}

// ── expiry ────────────────────────────────────────────────────────────────

/**
 * Find leads whose stage clock has run out.
 *
 * Read-only. Returns candidates WITH the reason each one is or is not safe to
 * expire, so a human or a supervisor can decide rather than have a sweep quietly
 * decide for them.
 *
 * @returns {Promise<Array<{lead_id, from, days_in_stage, due_in_days,
 *                           event_date, days_to_event, safe_to_expire, blocker}>>}
 */
export async function findExpiredLeads(query) {
  const { rows } = await query(`
    SELECT l.id AS lead_id, l.stage, l.stage_entered_at, l.event_date,
           l.contact_name, l.contact_email,
           EXTRACT(DAY FROM (NOW() - l.stage_entered_at))::int AS days_in_stage,
           s.max_days,
           EXTRACT(DAY FROM (l.event_date - NOW()))::int AS days_to_event
      FROM public.pfp_leads l
      JOIN public.pfp_lead_stages s ON s.code = l.stage
     WHERE l.stage IN ('new','negotiating')
       AND s.max_days IS NOT NULL
       AND l.stage_entered_at < NOW() - (s.max_days || ' days')::interval
     ORDER BY l.stage_entered_at ASC`);

  return rows.map((r) => {
    const days_to_event = r.days_to_event;
    // The event clock overrides the stage clock. A lead with an event inside the
    // guard window is not stale - it is imminent, and expiring it is how a
    // booked weekend gets given away.
    const imminent = days_to_event !== null && days_to_event <= EVENT_GUARD_DAYS;
    return {
      lead_id: r.lead_id,
      contact: r.contact_name || r.contact_email,
      from: r.stage,
      days_in_stage: r.days_in_stage,
      max_days: r.max_days,
      days_overdue: r.days_in_stage - r.max_days,
      event_date: r.event_date,
      days_to_event,
      safe_to_expire: !imminent,
      blocker: imminent
        ? `event in ${days_to_event} day(s) - inside the ${EVENT_GUARD_DAYS}-day guard. ` +
          `Needs a human, not a sweep.`
        : null,
    };
  });
}

/** Expire only the safe candidates. The imminent ones are returned untouched. */
export async function sweepExpiredLeads(query, { actor = 'sweep' } = {}) {
  const candidates = await findExpiredLeads(query);
  const expired = [];
  const held = [];
  for (const c of candidates) {
    if (!c.safe_to_expire) { held.push(c); continue; }
    const r = await advanceLeadStage(query, {
      lead_id: c.lead_id, to_stage: 'stale', actor,
      reason: 'no_response',
      note: `${c.days_in_stage} days in ${c.from} (limit ${c.max_days})`,
    });
    if (r.ok) expired.push({ ...c, result: r });
  }
  return { examined: candidates.length, expired: expired.length, held: held.length, expired_rows: expired, held_rows: held };
}

// ── people and events ─────────────────────────────────────────────────────

/**
 * The identity of a thread is its subject with every leading Re:/Fw: removed.
 *
 * Email has no portable thread id in the data we store, and the inbound webhook
 * gives us a subject but not the References headers. The normalized subject is
 * the best available key, and it is deliberately conservative: an exact match
 * only, so "Re: Hello" from a stranger is not folded into an unrelated lead
 * unless the subject really is identical.
 */
/**
 * Does this message ask us to stop?
 *
 * This is deliberately narrow. A keyword gate that fires on "stop" alone would
 * catch "stop by the venue", and a gate that fires on "remove" would catch
 * "remove the backdrop from the quote". Both would silently suppress a client.
 * So it looks for the shapes people actually use to opt out: the bare word, an
 * unsubscribe/opt-out line, "remove me/us", "do not contact", or "stop ...
 * emails/list/newsletter".
 */
const OPT_OUT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bremove (me|us)\b/i,
  /\btake me off\b/i,
  /\bdo not (email|contact|reach out|send)\b/i,
  /\bstop (emailing|contacting|sending|the emails|messages)\b/i,
  /^\s*(please\s+)?stop\s*[.!]*\s*$/i,
  /\bstop\b[^.\n]{0,40}\b(list|emails?|mailings?|newsletter)\b/i,
];

export function detectOptOut(subject, snippet) {
  const text = `${subject ?? ''} ${snippet ?? ''}`.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  for (const re of OPT_OUT_PATTERNS) {
    const m = text.match(re);
    if (m) return { matched: m[0], excerpt: text.slice(0, 300) };
  }
  return null;
}

/**
 * The identity of a thread is its subject with every leading Re:/Fw: removed.
 *
 * Email has no portable thread id in the data we store, and the inbound webhook
 * gives us a subject but not the References headers. The normalized subject is
 * the best available key, and it is deliberately conservative: an exact match
 * only, so "Re: Hello" from a stranger is not folded into an unrelated lead
 * unless the subject really is identical.
 */
export function normalizeThreadKey(subject) {
  return String(subject ?? '')
    .toLowerCase()
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Follow `merged_into_lead_id` to the surviving lead.
 *
 * A chain is followed rather than assumed one hop deep, because a second merge
 * (a planner address merged into a wedding lead, then that lead merged into a
 * venue event) must not strand the first pointer.
 */
export async function resolveLeadId(query, leadId) {
  let cur = leadId;
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    if (!cur) return null;
    if (seen.has(cur)) throw new Error(`merge cycle at lead ${cur}`);
    seen.add(cur);
    const { rows } = await query(
      'SELECT id, merged_into_lead_id FROM public.pfp_leads WHERE id = $1', [cur]);
    if (!rows.length) return null;
    if (!rows[0].merged_into_lead_id) return rows[0].id;
    cur = rows[0].merged_into_lead_id;
  }
  throw new Error(`merge chain longer than 10 starting at ${leadId}`);
}

/**
 * Attach a person to a lead. One row per person, one primary per lead.
 *
 * Refuses to silently move a contact who is already attached to a different
 * live lead: two events sharing a planner is a real thing, and deciding which
 * one a phone call belongs to is a human's job. `force` is the override, used
 * only by an explicit merge.
 */
export async function attachContact(query, {
  lead_id, email, name = null, role = 'contact', is_primary = false,
  notes = null, force = false,
}) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address || !address.includes('@')) {
    return { ok: false, error: 'a valid email is required to attach a contact' };
  }
  const target = await resolveLeadId(query, lead_id);
  if (!target) return { ok: false, error: `no live lead for ${lead_id}` };

  const { rows: existing } = await query(
    `SELECT id, lead_id, is_primary, name
       FROM public.pfp_contacts WHERE lower(email) = $1 LIMIT 1`, [address]);

  if (existing.length && existing[0].lead_id && existing[0].lead_id !== target && !force) {
    const other = await resolveLeadId(query, existing[0].lead_id);
    if (other && other !== target) {
      return {
        ok: false,
        error: `contact ${address} is already attached to lead ${other}; ` +
          'merge that lead first or pass force',
        contact_id: existing[0].id,
        existing_lead_id: other,
      };
    }
  }

  // Exactly one primary per lead. Demote the incumbent before promoting.
  if (is_primary) {
    await query(
      `UPDATE public.pfp_contacts SET is_primary = false, updated_at = NOW()
        WHERE lead_id = $1 AND is_primary AND lower(email) <> $2`, [target, address]);
  }

  const { rows } = await query(
    `INSERT INTO public.pfp_contacts (name, email, role, notes, lead_id, is_primary)
     VALUES (COALESCE($1, split_part($2,'@',1)), $2,$3,$4,$5,$6)
     ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET
       lead_id = EXCLUDED.lead_id,
       is_primary = pfp_contacts.is_primary OR EXCLUDED.is_primary,
       name = COALESCE(pfp_contacts.name, EXCLUDED.name),
       role = COALESCE(pfp_contacts.role, EXCLUDED.role),
       notes = COALESCE(pfp_contacts.notes, EXCLUDED.notes),
       updated_at = NOW()
     RETURNING id, lead_id, is_primary`,
    [name, address, role, notes, target, is_primary]);

  const contact = rows[0];
  if (contact.is_primary) {
    await query(
      `UPDATE public.pfp_leads SET primary_contact_id = $1, updated_at = NOW() WHERE id = $2`,
      [contact.id, target]);
  }
  return { ok: true, contact_id: contact.id, lead_id: target, is_primary: contact.is_primary };
}

// ── inbound capture ───────────────────────────────────────────────────────

/**
 * An email arrived. This is where a lead is born.
 *
 * Deduplicated on message_id, because an email gateway that retries a delivery
 * would otherwise create the same lead twice - and duplicate leads are how two
 * people end up with two contracts for one event.
 *
 * The campaign question is answered from the send log, not guessed: if we have
 * emailed this address through the campaign, the reply is a campaign reply.
 *
 * @param {(sql:string, params?:any[])=>Promise<any>} query
 * @param {{from_email:string, subject?:string, snippet?:string, body?:string,
 *          message_id?:string, received_at?:string, sender_name?:string}} email
 */
export async function captureInboundEmail(query, email) {
  const from = String(email.from_email || '').trim().toLowerCase();
  if (!from || !from.includes('@')) {
    return { ok: false, error: 'a valid from_email is required' };
  }

  // 1. Dedupe - but an unfinished capture is not a duplicate.
  //
  //    The inbound row is written before anything is decided, so a capture
  //    that threw halfway leaves a row with no outcome and no lead. That is
  //    not a processed message, it is an unfinished one, and the only way it
  //    can ever get an outcome is by being processed again. A row that HAS an
  //    outcome was processed, and must not be processed twice.
  let inboundId = null;
  if (email.message_id) {
    const dupe = await query(
      'SELECT id, lead_id, outcome FROM public.pfp_inbound_emails WHERE message_id = $1',
      [email.message_id]);
    if (dupe.rows.length) {
      const existing = dupe.rows[0];
      if (existing.outcome === null && existing.lead_id === null) {
        inboundId = existing.id;
      } else {
        return {
          ok: true, duplicate: true,
          lead_id: existing.lead_id, outcome: existing.outcome,
          note: 'this message_id was already processed; no second lead created',
        };
      }
    }
  }

  const threadKey = normalizeThreadKey(email.subject) || null;

  // 2. Insert the inbound record first. Always, so the message exists even when
  //    it turns out to belong to no lead (or to us).
  //
  //    The select above is not a lock. The webhook and the 15-minute poller can
  //    both see the same message as new and both try to insert it, and two
  //    leads for one reply is exactly what the contact model exists to prevent.
  //    The unique index on message_id is what actually stops it, so a collision
  //    is caught here and answered as the duplicate it is.
  if (inboundId === null) {
    let inbound;
    try {
      inbound = await query(
        `INSERT INTO public.pfp_inbound_emails
           (message_id, sender_email, sender_name, subject, snippet, thread_key)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [email.message_id ?? null, from, email.sender_name ?? null,
         email.subject ?? null, email.snippet ?? null, threadKey]);
    } catch (err) {
      if (err?.code !== '23505') throw err;
      const existing = await query(
        'SELECT id, lead_id, outcome FROM public.pfp_inbound_emails WHERE message_id = $1',
        [email.message_id]);
      return {
        ok: true,
        duplicate: true,
        lead_id: existing.rows[0]?.lead_id ?? null,
        outcome: existing.rows[0]?.outcome ?? null,
        note: 'another caller captured this message first; no second lead created',
      };
    }
    inboundId = inbound.rows[0].id;
  }

  const finish = async (outcome, leadId, extra = {}) => {
    await query(
      'UPDATE public.pfp_inbound_emails SET lead_id = $1, outcome = $2 WHERE id = $3',
      [leadId, outcome, inboundId]);
    return { ok: true, created: false, lead_id: leadId, outcome, ...extra };
  };

  // 3. Our own addresses never become leads. The studio emailing itself is not
  //    organic inbound, and the old behaviour made it look like a hot prospect.
  const { rows: internal } = await query(
    `SELECT reason FROM public.pfp_internal_addresses WHERE lower(email) = $1`, [from]);
  if (internal.length) {
    return finish('internal_ignored', null, {
      internal: true,
      reason: internal[0].reason,
      note: 'this address belongs to the studio; no lead was created',
    });
  }

  // 3b. Opt-out. "STOP", "unsubscribe", "remove me" is not a lead - it is an
  //     instruction never to contact this address again. The old path filed
  //     tdent@lpc.com's "STOP - Remove for list" as `lead_created` on 2026-10-19
  //     and left the suppression table empty, so the campaign could keep
  //     emailing someone who had asked it to stop.
  //
  //     The inbound row is still recorded, and still linked to a known lead if
  //     we have one, so the request is traceable. The address is what gets
  //     suppressed; the event is not resurrected.
  const optOut = detectOptOut(email.subject, email.snippet);
  if (optOut) {
    // `suppress` returns false when the write failed. Do not report a
    // suppression that did not happen.
    const recorded = await suppress(query, null, from, 'inbound_opt_out', optOut.excerpt);
    let known = null;
    const { rows: k } = await query(
      `SELECT lead_id FROM public.pfp_contacts
        WHERE lower(email) = $1 AND lead_id IS NOT NULL LIMIT 1`, [from]);
    if (k.length) known = await resolveLeadId(query, k[0].lead_id);
    return finish(recorded ? 'suppressed' : 'opt_out_not_recorded', known, {
      suppressed: recorded,
      matched: optOut.matched,
      note: recorded
        ? 'sender asked not to be contacted; address added to the suppression list'
        : 'sender asked not to be contacted, but the suppression write failed - do not email this address',
    });
  }

  // 4. A known person. Their contact row says which event they belong to, so a
  //    reply from the groom lands on the wedding rather than opening a lead.
  const { rows: contactRows } = await query(
    `SELECT id, lead_id, is_primary
       FROM public.pfp_contacts
      WHERE lower(email) = $1 AND lead_id IS NOT NULL LIMIT 1`, [from]);
  if (contactRows.length) {
    const target = await resolveLeadId(query, contactRows[0].lead_id);
    if (target) {
      const { rows: tl } = await query(
        'SELECT stage FROM public.pfp_leads WHERE id = $1', [target]);
      const stage = tl[0]?.stage ?? null;
      let move = null;
      if (stage === 'stale' || stage === 'lost') {
        move = await advanceLeadStage(query, {
          lead_id: target, to_stage: 'new', actor: 'inbox',
          reason: stage === 'lost' ? 'client_replied_after_lost' : 'client_replied_after_stale',
          note: 'a dormant lead that came back',
        });
      } else {
        await query(
          `UPDATE public.pfp_leads
              SET first_reply_at = COALESCE(first_reply_at, NOW()), updated_at = NOW()
            WHERE id = $1`, [target]);
      }
      return finish(move ? 'resurrected' : 'contact_reply', target, {
        contact_id: contactRows[0].id,
        stage: move ? 'new' : stage,
        resurrected: Boolean(move),
        note: 'sender is already a contact on this lead; no second lead created',
      });
    }
  }

  // 5. Was it a campaign contact? Asked, not inferred.
  const { rows: camp } = await query(
    `SELECT count(*)::int AS n, max(sent_at) AS last_sent
       FROM public.pfp_campaign_sends
      WHERE lower(email) = $1 AND status <> 'error'`, [from]);
  const from_campaign = camp[0]?.n > 0;

  // 6. Existing lead for this address? Merged duplicates are skipped - the
  //    survivor is found through the contact table or the merge pointer.
  const { rows: found } = await query(
    `SELECT id, stage, event_type, venue_name, contact_name
       FROM public.pfp_leads
      WHERE lower(contact_email) = $1 AND merged_into_lead_id IS NULL
      ORDER BY created_at ASC LIMIT 1`, [from]);
  const lead = found[0];

  // 7. Same thread, a different person. This is the wedding case: the groom
  //    replies on the thread the bride started and the inbox used to invent a
  //    second lead. Attach him to the event instead.
  if (!lead && threadKey) {
    const { rows: thread } = await query(
      `SELECT i.lead_id
         FROM public.pfp_inbound_emails i
         JOIN public.pfp_leads l ON l.id = i.lead_id
        WHERE i.thread_key = $1
          AND i.lead_id IS NOT NULL
          AND i.id <> $2
          AND l.merged_into_lead_id IS NULL
          AND i.received_at > NOW() - INTERVAL '90 days'
        ORDER BY i.received_at ASC LIMIT 1`, [threadKey, inboundId]);
    if (thread.length) {
      const target = await resolveLeadId(query, thread[0].lead_id);
      if (target) {
        const attached = await attachContact(query, {
          lead_id: target, email: from, name: email.sender_name ?? null,
          role: 'contact',
        });
        if (attached.ok) {
          await query(
            `UPDATE public.pfp_leads SET updated_at = NOW() WHERE id = $1`, [target]);
          return finish('contact_attached', target, {
            contact_id: attached.contact_id,
            note: 'same email thread as an existing lead; attached as a contact, no new lead',
          });
        }
      }
    }
  }

  // 8. No lead: create one in `new`, and make the sender its primary contact.
  if (!lead) {
    const created = await query(
      `INSERT INTO public.pfp_leads
         (contact_name, contact_email, source, source_code, stage, stage_entered_at, first_reply_at, status, notes)
       VALUES ($1,$2,$3,$4,'new',NOW(),NOW(),'NEW',$5)
       RETURNING id, stage`,
      [
        email.sender_name ?? null,
        from,
        from_campaign ? 'campaign reply' : 'inbound email',
        from_campaign ? 'campaign_outbound' : 'email_inquiry',
        `First reply received ${new Date(email.received_at ?? Date.now()).toISOString()}.` +
          (from_campaign
            ? ` Reply to a campaign send (last campaign email ${camp[0].last_sent}).`
            : ` Organic inbound - never contacted by us.`),
      ]);
    const leadId = created.rows[0].id;
    await query(
      `INSERT INTO public.pfp_lead_stage_history (lead_id, from_stage, to_stage, reason, actor, note)
       VALUES ($1,NULL,'new',$2,'inbox',$3)`,
      [leadId, from_campaign ? 'campaign_reply' : 'organic_reply',
       email.subject ? `re: ${email.subject}` : null]);
    await attachContact(query, {
      lead_id: leadId, email: from, name: email.sender_name ?? null,
      role: 'primary client', is_primary: true,
    });
    return finish('lead_created', leadId, {
      created: true,
      stage: 'new',
      from_campaign,
      source: from_campaign ? 'campaign reply' : 'organic inbound',
      next: 'Send a quote or contract within 30 days or the lead goes stale.',
    });
  }

  // 9. Existing lead: this is a reply, and it may resurrect a dormant one.
  const prior = lead.stage;
  let move = null;
  if (prior === 'stale' || prior === 'lost') {
    move = await advanceLeadStage(query, {
      lead_id: lead.id, to_stage: 'new', actor: 'inbox',
      reason: prior === 'lost' ? 'client_replied_after_lost' : 'client_replied_after_stale',
      note: 'a dormant lead that came back',
    });
  } else {
    await query(
      `UPDATE public.pfp_leads SET first_reply_at = COALESCE(first_reply_at, NOW()), updated_at = NOW()
        WHERE id = $1`, [lead.id]);
  }

  // Make sure the sender is a contact on their own lead. A lead created before
  // this model existed has no contact row, and the next email would otherwise
  // be the one that needed it.
  await attachContact(query, {
    lead_id: lead.id, email: from, name: email.sender_name ?? null,
    role: 'contact',
  });

  return finish(move ? 'resurrected' : 'reply_logged', lead.id, {
    stage: lead.stage,
    was_stage: prior,
    resurrected: Boolean(move),
    from_campaign,
    next: move
      ? `Resurrected from ${prior} into new. The 30-day clock starts again.`
      : `Reply logged against a lead already in "${prior}".`,
  });
}

// ── reporting ─────────────────────────────────────────────────────────────

/**
 * The pipeline tile. Every number computed from live columns and the history
 * table, so the tile cannot disagree with the data.
 */
export async function pipelineStats(query, { days = 30 } = {}) {
  const byStage = await query(
    `SELECT stage, count(*)::int AS n,
            count(*) FILTER (WHERE event_date IS NOT NULL AND event_date >= CURRENT_DATE)::int AS with_future_event
       FROM public.pfp_leads WHERE stage IS NOT NULL GROUP BY stage`);

  const overdue = await query(
    `SELECT l.stage, count(*)::int AS n,
            min(EXTRACT(DAY FROM (NOW() - l.stage_entered_at))::int) AS oldest_days
       FROM public.pfp_leads l JOIN public.pfp_lead_stages s ON s.code = l.stage
      WHERE l.stage IN ('new','negotiating') AND s.max_days IS NOT NULL
        AND l.stage_entered_at < NOW() - (s.max_days || ' days')::interval
      GROUP BY l.stage`);

  const loss = await query(
    `SELECT lost_reason, count(*)::int AS n
       FROM public.pfp_leads WHERE stage = 'lost' AND lost_reason IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`);

  const arrivals = await query(
    `SELECT date_trunc('day', received_at)::date AS day,
            count(*)::int AS total,
            count(*) FILTER (WHERE outcome = 'lead_created')::int AS new_leads,
            count(*) FILTER (WHERE outcome = 'resurrected')::int AS resurrected
       FROM public.pfp_inbound_emails
      WHERE received_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [String(days)]);

  const conv = await query(`
    SELECT
      count(*) FILTER (WHERE stage = 'booked')::int                        AS booked,
      count(*) FILTER (WHERE stage IN ('lost','stale'))::int              AS not_working,
      count(*) FILTER (WHERE stage IN ('new','negotiating'))::int          AS working
    FROM public.pfp_leads WHERE stage IS NOT NULL`);

  // byStage is the full query result; the rows are what get reduced. Passing the
  // result object here threw `reduce is not a function`.
  const stageRows = byStage.rows ?? [];
  const s = stageRows.reduce((a, r) => (a[r.stage] = r.n, a), {});
  const c = conv.rows[0] ?? {};
  const decided = (c.booked || 0) + (c.not_working || 0);

  return {
    window_days: Number(days),
    by_stage: stageRows.map((r) => ({
      stage: r.stage,
      label: stageByCode.get(r.stage)?.label ?? r.stage,
      count: r.n,
      with_future_event: r.with_future_event,
      max_days: stageByCode.get(r.stage)?.max_days ?? null,
    })),
    working: c.working ?? 0,
    booked: c.booked ?? 0,
    not_working: c.not_working ?? 0,
    // Conversion only counts leads that reached a decision. Stale and lost are
    // both "not working"; counting stale as a loss would understate the rate and
    // make the number look worse than the business is.
    decided: decided,
    conversion_to_booked: decided > 0 ? Number((((c.booked || 0) / decided) * 100).toFixed(1)) : null,
    overdue: overdue.rows.map((r) => ({
      stage: r.stage, count: r.n, oldest_days: r.oldest_days,
    })),
    loss_reasons: loss.rows,
    arrivals_by_day: arrivals.rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      total: r.total, new_leads: r.new_leads, resurrected: r.resurrected,
    })),
  };
}

export default {
  STAGES, TRANSITIONS, LOSS_REASONS, EVENT_GUARD_DAYS, LEAD_STAGE_CODES,
  ensureLeadStageSchema, seedStages, advanceLeadStage, markContractSent,
  markPaymentReceived, findExpiredLeads, sweepExpiredLeads,
  captureInboundEmail, pipelineStats,
};