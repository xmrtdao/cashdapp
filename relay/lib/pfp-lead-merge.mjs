/**
 * relay/lib/pfp-lead-merge.mjs — roll one lead into another without losing the
 * evidence that it existed.
 *
 * WHY THIS IS NOT A DELETE
 * ------------------------
 * A duplicate lead is a record that a message arrived and how it was classified.
 * Deleting it makes the inbox history lie: replies point at a lead that no longer
 * exists, and nobody can reconstruct why a second lead appeared. So a merge
 * keeps the loser, points it at the survivor with `merged_into_lead_id`, and
 * moves it to `lost` with reason `duplicate` - which is exactly what it is.
 *
 * WHAT MOVES, AND WHAT REFUSES TO
 * -------------------------------
 * Inbound emails, quotes and contacts follow the person to the surviving lead.
 * A BOOKING DOES NOT: if both leads have a booking, the merge is refused,
 * because two bookings for one event is a conflict to surface, not a range to
 * union. The same rule the dossier merge follows.
 */

import { advanceLeadStage, attachContact, resolveLeadId } from './pfp-lead-stages.mjs';

/**
 * Merge `duplicate_lead_id` into `target_lead_id`.
 *
 * @param {(sql:string, params?:any[])=>Promise<any>} query
 * @param {{duplicate_lead_id:string, target_lead_id:string,
 *          role?:string, name?:string|null, note?:string, actor?:string}} args
 */
export async function mergeLeadInto(query, args) {
  const {
    duplicate_lead_id, target_lead_id,
    role = 'contact', name = null, note = null, actor = 'merge',
  } = args;

  if (!duplicate_lead_id || !target_lead_id) {
    return { ok: false, error: 'duplicate_lead_id and target_lead_id are required' };
  }
  if (duplicate_lead_id === target_lead_id) {
    return { ok: false, error: 'a lead cannot be merged into itself' };
  }

  const target = await resolveLeadId(query, target_lead_id);
  if (!target) return { ok: false, error: `no target lead ${target_lead_id}` };
  if (target !== target_lead_id) {
    return {
      ok: false,
      error: `target ${target_lead_id} is itself merged into ${target}; ` +
        'merge into the survivor instead',
    };
  }

  const { rows } = await query(
    `SELECT id, contact_email, contact_name, stage, merged_into_lead_id
       FROM public.pfp_leads WHERE id = ANY($1::uuid[])`,
    [[duplicate_lead_id, target]]);
  const dup = rows.find((r) => r.id === duplicate_lead_id);
  const tgt = rows.find((r) => r.id === target);
  if (!dup) return { ok: false, error: `no duplicate lead ${duplicate_lead_id}` };
  if (!tgt) return { ok: false, error: `no target lead ${target}` };

  // Idempotent: a second run reports the merge instead of inventing a second one.
  if (dup.merged_into_lead_id) {
    if (dup.merged_into_lead_id === target) {
      return { ok: true, already_merged: true, duplicate_lead_id, target_lead_id: target };
    }
    return {
      ok: false,
      error: `lead ${duplicate_lead_id} is already merged into ${dup.merged_into_lead_id}`,
    };
  }

  // Two bookings for one event is a conflict, not something a merge resolves.
  const { rows: dupBookings } = await query(
    'SELECT id, event_name, event_date FROM public.pfp_bookings WHERE lead_id = $1',
    [duplicate_lead_id]);
  const { rows: tgtBookings } = await query(
    'SELECT id, event_name, event_date FROM public.pfp_bookings WHERE lead_id = $1',
    [target]);
  if (dupBookings.length && tgtBookings.length) {
    return {
      ok: false,
      error: `both leads have bookings (${dupBookings.length} on the duplicate, ` +
        `${tgtBookings.length} on the target). Refusing to merge - two bookings for ` +
        'one event is a conflict for a human to resolve.',
      duplicate_bookings: dupBookings,
      target_bookings: tgtBookings,
    };
  }

  const moved = { bookings: 0, quotes: 0, inbound_emails: 0, contacts: 0 };

  if (dupBookings.length) {
    const r = await query(
      'UPDATE public.pfp_bookings SET lead_id = $1 WHERE lead_id = $2',
      [target, duplicate_lead_id]);
    moved.bookings = r.rowCount ?? 0;
  }

  // Quotes follow only when the target has none. A quote is a priced offer for
  // one event; silently accumulating two on one lead is how a client is quoted
  // twice for the same night.
  const { rows: tgtQuotes } = await query(
    'SELECT count(*)::int AS n FROM public.pfp_quotes WHERE lead_id = $1', [target]);
  if (tgtQuotes[0].n === 0) {
    const r = await query(
      'UPDATE public.pfp_quotes SET lead_id = $1 WHERE lead_id = $2',
      [target, duplicate_lead_id]);
    moved.quotes = r.rowCount ?? 0;
  }

  const ri = await query(
    'UPDATE public.pfp_inbound_emails SET lead_id = $1 WHERE lead_id = $2',
    [target, duplicate_lead_id]);
  moved.inbound_emails = ri.rowCount ?? 0;

  // Contacts attached to the duplicate move across. Demote every primary first:
  // the partial unique index allows exactly one per lead.
  const rc = await query(
    `UPDATE public.pfp_contacts
        SET lead_id = $1, is_primary = false, updated_at = NOW()
      WHERE lead_id = $2`, [target, duplicate_lead_id]);
  moved.contacts = rc.rowCount ?? 0;

  // The duplicate's own address becomes a contact on the survivor.
  if (dup.contact_email) {
    const attached = await attachContact(query, {
      lead_id: target, email: dup.contact_email,
      name: name ?? dup.contact_name ?? null, role, force: true,
    });
    if (!attached.ok) {
      return { ok: false, error: `could not attach ${dup.contact_email}: ${attached.error}` };
    }
  }

  // Keep exactly one primary on the target. If nobody is primary, promote the
  // survivor's own address; otherwise leave the existing one alone.
  const { rows: prim } = await query(
    'SELECT count(*)::int AS n FROM public.pfp_contacts WHERE lead_id = $1 AND is_primary',
    [target]);
  if (prim[0].n === 0 && tgt.contact_email) {
    await attachContact(query, {
      lead_id: target, email: tgt.contact_email,
      name: tgt.contact_name ?? null, role: 'primary client', is_primary: true, force: true,
    });
  }

  // Point the loser at the winner. This is the record of the merge.
  await query(
    `UPDATE public.pfp_leads SET merged_into_lead_id = $1, updated_at = NOW() WHERE id = $2`,
    [target, duplicate_lead_id]);

  // `duplicate` is a first-class loss reason, so the stage history says what
  // happened without needing a second table.
  const stage = await advanceLeadStage(query, {
    lead_id: duplicate_lead_id, to_stage: 'lost', reason: 'duplicate', actor,
    note: note ?? `merged into ${target}`,
  });
  if (stage.unchanged) {
    await query(
      `INSERT INTO public.pfp_lead_stage_history (lead_id, from_stage, to_stage, reason, actor, note)
       VALUES ($1,'lost','lost','duplicate',$2,$3)`,
      [duplicate_lead_id, actor, note ?? `merged into ${target}`]);
  }

  await query(
    `UPDATE public.pfp_leads
        SET notes = COALESCE(notes || E'\n', '') ||
            $1, updated_at = NOW()
      WHERE id = $2`,
    [`Merged lead ${duplicate_lead_id} (${dup.contact_email ?? 'no address'}) into this ` +
     `lead on ${new Date().toISOString().slice(0, 10)} as "${role}". ` +
     'The duplicate row is retained and points here via merged_into_lead_id.', target]);

  return {
    ok: true,
    duplicate_lead_id, target_lead_id: target,
    moved,
    duplicate_stage: stage.to ?? 'lost',
    note: 'duplicate retained, pointed at the survivor, and marked lost/duplicate',
  };
}
