/**
 * relay/scripts/pfp-consolidate-jaffee.mjs
 *
 * ONE WEDDING, ONE LEAD, TWO PEOPLE - AND THE STUDIO IS NOT A LEAD.
 *
 * This is the first real use of the model in migrations/pfp_011_lead_contacts.sql.
 * It does not touch the booking: the booking is already correct (Jaffee-Knapp,
 * Rosemont Manor, 2026-11-08, paid in full). It corrects the leads that point at
 * it and proves the result from the database.
 *
 *   node relay/scripts/pfp-consolidate-jaffee.mjs            # plan only
 *   LOCAL_DATABASE_URL=... node relay/scripts/pfp-consolidate-jaffee.mjs --apply
 *
 * The apply path runs in ONE transaction and verifies before COMMIT. A failed
 * check rolls the whole thing back, so a half-merged pair cannot survive.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import {
  advanceLeadStage, attachContact, markPaymentReceived,
} from '../lib/pfp-lead-stages.mjs';
import { mergeLeadInto } from '../lib/pfp-lead-merge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, '..', 'migrations', 'pfp_011_lead_contacts.sql');

const BOOKING_ID = 'd478d63b-06d2-4aab-8666-c2bdb922888c';
const GROOM_EMAIL = 'jknapp1990@gmail.com';
const INTERNAL_EMAIL = 'pfpattendants@gmail.com';
const PAYMENT_INTENT = 'pi_3TtB62Hl7S6PuGva0XxrOQUf';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL,
});
const client = await pool.connect();
const q = (sql, params) => client.query(sql, params);
const say = (...a) => console.log(...a);

let exitCode = 0;

try {
  if (APPLY) await q('BEGIN');

  // The schema additions are prerequisite even for a read-only plan; they are
  // DDL plus the internal-address seed, and idempotent.
  await q(readFileSync(MIGRATION, 'utf8'));
  say('[consolidate] pfp_011_lead_contacts.sql applied (schema)');
  if (!APPLY) say('[consolidate] plan only - pass --apply to write data');

  // ── the booking is the source of truth for who and when ────────────────
  const { rows: [booking] } = await q(
    `SELECT id, lead_id, client_name, client_email, event_name, event_date,
            venue, total_fee, deposit_paid, contract_signed, status
       FROM public.pfp_bookings WHERE id = $1`, [BOOKING_ID]);
  if (!booking) throw new Error(`booking ${BOOKING_ID} not found`);
  if (!booking.lead_id) throw new Error('booking has no lead_id; refusing to guess one');

  const target = booking.lead_id;
  const eventDate = new Date(booking.event_date).toISOString().slice(0, 10);
  say(`[consolidate] booking   ${booking.event_name} | ${booking.venue} | ${eventDate}`);
  say(`[consolidate] client(s) ${booking.client_name} <${booking.client_email}> + Jonathan Knapp <${GROOM_EMAIL}>`);
  say(`[consolidate] survivor  lead ${target}`);

  // ── the duplicate lead created from the groom's reply ──────────────────
  const { rows: groomLeads } = await q(
    `SELECT id, contact_email, stage, merged_into_lead_id
       FROM public.pfp_leads
      WHERE lower(contact_email) = $1 AND merged_into_lead_id IS NULL`, [GROOM_EMAIL]);

  if (groomLeads.length > 1) {
    throw new Error(`more than one live lead for ${GROOM_EMAIL}: ` +
      groomLeads.map((r) => r.id).join(', ') + ' - needs a human decision');
  }

  if (!groomLeads.length) {
    say('[consolidate] groom lead: none live (already consolidated)');
  } else {
    const groom = groomLeads[0];
    say(`[consolidate] groom lead ${groom.id} (stage ${groom.stage}) -> merge as partner`);
    if (APPLY) {
      const r = await mergeLeadInto(q, {
        duplicate_lead_id: groom.id,
        target_lead_id: target,
        role: 'partner / second client',
        name: 'Jonathan Knapp',
        note: 'second client named on booking ' + BOOKING_ID,
        actor: 'booking-reconcile',
      });
      if (!r.ok) throw new Error('merge failed: ' + r.error);
      say(`[consolidate] merged: ${JSON.stringify(r.moved)}`);
    }
  }

  // ── the studio's own reply-from address is not a client ────────────────
  const { rows: internalLeads } = await q(
    `SELECT id, stage, merged_into_lead_id FROM public.pfp_leads
      WHERE lower(contact_email) = $1`, [INTERNAL_EMAIL]);
  for (const lead of internalLeads) {
    if (lead.stage === 'lost' || lead.merged_into_lead_id) {
      say(`[consolidate] internal lead ${lead.id}: already closed (${lead.stage})`);
      continue;
    }
    say(`[consolidate] internal lead ${lead.id} (stage ${lead.stage}) -> not_a_lead`);
    if (APPLY) {
      const r = await advanceLeadStage(q, {
        lead_id: lead.id, to_stage: 'lost', reason: 'not_a_lead', actor: 'booking-reconcile',
        note: 'studio reply-from address (Photographic & Communication Services, signed Joe); ' +
          'not a client and never was a lead',
      });
      if (!r.ok) throw new Error('internal lead close failed: ' + r.error);
      await q(`UPDATE public.pfp_leads SET status = 'lost', updated_at = NOW() WHERE id = $1`,
        [lead.id]);
    }
  }

  // ── describe the survivor from the booking, never from a guess ─────────
  say('[consolidate] survivor fields: contact_name / event_date / venue_name from the booking');
  if (APPLY) {
    await q(
      `UPDATE public.pfp_leads
          SET contact_name = COALESCE(contact_name, $2),
              event_date   = COALESCE(event_date, $3::date),
              venue_name   = COALESCE(venue_name, $4),
              updated_at   = NOW()
        WHERE id = $1`,
      [target, booking.client_name, eventDate, booking.venue]);
  }

  // ── both people become contacts on the one lead ────────────────────────
  if (APPLY) {
    const natalia = await attachContact(q, {
      lead_id: target, email: booking.client_email, name: booking.client_name,
      role: 'primary client', is_primary: true, force: true,
    });
    if (!natalia.ok) throw new Error('could not attach Natalia: ' + natalia.error);

    const jonathan = await attachContact(q, {
      lead_id: target, email: GROOM_EMAIL, name: 'Jonathan Knapp',
      role: 'partner / second client', force: true,
    });
    if (!jonathan.ok) throw new Error('could not attach Jonathan: ' + jonathan.error);
    say(`[consolidate] contacts: ${natalia.contact_id} (primary), ${jonathan.contact_id}`);

    // A contact row may already have existed from the address alone, with the
    // local part as a placeholder name. The booking carries the real name, so
    // use it - this is sourced, not inferred.
    await q(
      `UPDATE public.pfp_contacts SET name = $1, updated_at = NOW()
        WHERE lower(email) = lower($2)`, [booking.client_name, booking.client_email]);
  }

  // ── payment was received; the lead stage should say so ─────────────────
  const cents = Math.round(Number(booking.total_fee) * 100);
  say(`[consolidate] lead stage -> booked (${cents} cents, ${PAYMENT_INTENT})`);
  if (APPLY) {
    const r = await markPaymentReceived(q, {
      lead_id: target, amount_cents: cents, payment_id: PAYMENT_INTENT,
      actor: 'booking-reconcile',
    });
    if (!r.ok) throw new Error('could not mark the lead booked: ' + r.error);
  }

  // ── prove it from the database, not from the calls above ───────────────
  const { rows: [after] } = await q(
    `SELECT l.id, l.stage, l.status, l.contact_name, l.contact_email,
            l.event_date, l.venue_name, l.merged_into_lead_id,
            (SELECT count(*)::int FROM public.pfp_bookings b WHERE b.lead_id = l.id) AS bookings
       FROM public.pfp_leads l WHERE l.id = $1`, [target]);
  const { rows: contacts } = await q(
    `SELECT email, name, role, is_primary FROM public.pfp_contacts
      WHERE lead_id = $1 ORDER BY is_primary DESC, email`, [target]);
  const { rows: groomAfter } = await q(
    `SELECT id, stage, lost_reason, merged_into_lead_id FROM public.pfp_leads
      WHERE lower(contact_email) = $1`, [GROOM_EMAIL]);
  const { rows: internalAfter } = await q(
    `SELECT id, stage, lost_reason, merged_into_lead_id FROM public.pfp_leads
      WHERE lower(contact_email) = $1`, [INTERNAL_EMAIL]);
  const { rows: liveLeads } = await q(
    `SELECT id, contact_email, stage FROM public.pfp_leads
      WHERE lower(contact_email) IN ($1,$2) AND merged_into_lead_id IS NULL
        AND stage <> 'lost'`, [GROOM_EMAIL, INTERNAL_EMAIL]);

  say('\n=== result ===');
  say('lead:     ' + JSON.stringify(after));
  say('contacts: ' + JSON.stringify(contacts));
  say('groom:    ' + JSON.stringify(groomAfter));
  say('internal: ' + JSON.stringify(internalAfter));
  say('live duplicate leads for these addresses: ' + liveLeads.length);

  const problems = [];
  if (!after) problems.push('survivor lead missing');
  if (after && after.bookings !== 1) problems.push(`survivor has ${after.bookings} bookings, expected 1`);
  if (after && after.stage !== 'booked') problems.push(`survivor stage is "${after.stage}", expected booked`);
  if (contacts.length !== 2) problems.push(`${contacts.length} contacts on the survivor, expected 2`);
  if (contacts.filter((c) => c.is_primary).length !== 1) problems.push('survivor does not have exactly one primary contact');
  if (!contacts.some((c) => c.is_primary && c.name === booking.client_name)) {
    problems.push(`primary contact is not named "${booking.client_name}"`);
  }
  if (groomAfter.length !== 1) problems.push(`${groomAfter.length} groom lead rows, expected 1`);
  if (groomAfter[0] && groomAfter[0].merged_into_lead_id !== target) problems.push('groom lead is not pointed at the survivor');
  if (groomAfter[0] && groomAfter[0].stage !== 'lost') problems.push(`groom lead stage is "${groomAfter[0].stage}", expected lost`);
  if (internalAfter.some((r) => r.stage !== 'lost' && !r.merged_into_lead_id)) problems.push('internal lead is still live');
  if (liveLeads.length) problems.push(`${liveLeads.length} live duplicate lead(s) remain`);

  if (problems.length) {
    say('\nPROBLEMS:');
    for (const p of problems) say('  - ' + p);
    if (APPLY) {
      await q('ROLLBACK');
      say('[consolidate] rolled back - nothing was written');
    }
    exitCode = 1;
  } else if (APPLY) {
    await q('COMMIT');
    say('\nall checks passed: one booked lead, two contacts, no live duplicates');
  } else {
    say('\nplan complete (current state shown above; pass --apply to write)');
  }
} catch (e) {
  try { if (APPLY) await q('ROLLBACK'); } catch { /* already closed */ }
  console.error('[consolidate] FAIL: ' + e.message);
  exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
process.exit(exitCode);
