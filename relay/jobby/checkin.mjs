// relay/jobby/checkin.mjs — Jobby talks to the person it works for, then waits
//
// loop.mjs gave Jobby a heartbeat and a deterministic decision. That alone makes
// it busy. Busy is not the goal, and an agent that works unattended and never
// says anything is indistinguishable from one that is stuck - which is the
// failure this repo has already paid for once, on the LinkedIn profile.
//
// So the loop also talks. After it does something worth knowing about, it writes
// to the candidate from their own @jobbymcjobberson.com address, says what
// actually changed, and then STOPS until they answer.
//
// THE WAIT IS A CONSTRAINT.
//
// `job_checkins_one_open_idx` is a partial unique index: at most one unanswered
// check-in per client. Not a check in a loop, not a counter in a prompt, not a
// field the caller is trusted to respect - an index. A retry, a second worker, a
// future code path nobody has written yet, all of them hit it. That is the whole
// design: the loop cannot spam because the database will not let it, and the
// failure mode is a loud error naming a real reason rather than a muted inbox.
//
// THE WAIT HAS ONE DOOR, AND IT IS FOR EVENTS.
//
// An offer does not wait for a polite reply to be acknowledged. offer,
// interview, deadline and blocker are recorded in job_escalations, separately
// from check-ins, because the response to an event is action rather than a
// letter, and because putting them in one table with a nullable column would
// make it possible to close an offer by answering it.
//
// EVERYTHING HERE IS READ-ONLY WITH RESPECT TO THE CANDIDATE'S RECORD.
//
// Composing a message is not the same as knowing it is true. Nothing in this file
// writes a fact about the person, asserts a number they did not give, or fills a
// gap in their dossier. If the loop cannot say why it is writing, it does not
// write - see notWorthSending().

import { readFileSync } from 'fs';

/** Reasons the loop may write. Anything else is not a reason. */
export const CHECKIN_KINDS = ['progress', 'question', 'urgent', 'closing'];

/**
 * Events that break the wait.
 *
 * Deliberately a short, closed list. "Urgent" left to a model is a judgement
 * that drifts upward until everything is urgent, and a loop that treats routine
 * progress as urgent has no urgent state left.
 */
export const ESCALATION_KINDS = ['offer', 'interview', 'deadline', 'blocker'];

/** Evidence for an escalation. A word in an email is not an offer. */
const OFFER_MARKERS = /\b(offer(ed)?|letter of intent|\bLOI\b|salary|compensation package|we('d| would) like to (offer|hire)|sign(ed|ing)? (the )?contract)\b/i;
const INTERVIEW_MARKERS = /\b(interview|phone screen|technical screen|onsite|on-site|schedule(d)? (a|an)? ?call|availability this week|invite you to)\b/i;
const DEADLINE_MARKERS = /\b(deadline|expires?( in| on)?|respond by|offer (is )?open (for|until)|last (day|chance)|closing (date|soon))\b/i;

/**
 * Is this worth breaking the wait for?
 *
 * Pure, and deliberately conservative: it is handed the SUBJECT and BODY of
 * something received, and it returns a classification plus the evidence it
 * matched on. Returning the match is the point - a classification nobody can
 * audit is just a second opinion, and this one decides whether an agent breaks
 * its own silence.
 *
 * @returns {{escalate: boolean, kind: string|null, evidence: string|null}}
 */
export function classifyInbound(text) {
  const body = String(text ?? '');
  if (!body.trim()) return { escalate: false, kind: null, evidence: null };

  const rules = [
    ['offer', OFFER_MARKERS],
    ['interview', INTERVIEW_MARKERS],
    ['deadline', DEADLINE_MARKERS],
  ];
  for (const [kind, re] of rules) {
    const m = body.match(re);
    if (m) return { escalate: true, kind, evidence: m[0].trim().slice(0, 80) };
  }
  return { escalate: false, kind: null, evidence: null };
}

/**
 * Is there an unanswered question outstanding?
 *
 * The answer decides whether the loop is allowed to speak at all, and whether it
 * is allowed to keep working. One query, no caching: a stale cache here would
 * mean writing a second email, which is the exact thing being prevented.
 */
export async function openCheckin(pool, clientId) {
  const { rows } = await pool.query(
    `SELECT id, kind, decision, sent_at FROM app.job_checkins
      WHERE client_id = $1 AND still_open
      LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

export async function unactedEscalations(pool, clientId) {
  const { rows } = await pool.query(
    `SELECT id, kind, detail, detected_at FROM app.job_escalations
      WHERE client_id = $1 AND acted_on_at IS NULL
      ORDER BY detected_at`,
    [clientId]
  );
  return rows;
}

/**
 * Record that something arrived worth breaking the wait for.
 *
 * Idempotent per (client, kind) while unacted, so a poller that sees the same
 * offer on three consecutive ticks raises it once.
 */
export async function recordEscalation(pool, clientId, kind, detail = {}) {
  if (!ESCALATION_KINDS.includes(kind)) {
    throw new Error(`unknown escalation kind '${kind}' - add it to ESCALATION_KINDS deliberately`);
  }
  const { rows } = await pool.query(
    `INSERT INTO app.job_escalations (client_id, kind, detail)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id, kind, detail`,
    [clientId, kind, JSON.stringify(detail ?? {})]
  );
  // A conflict means it is already on record and unacted, which is the outcome
  // we wanted anyway. Return the existing row's identity so the caller can tell
  // "raised" from "already known" without querying again.
  if (rows.length) return { raised: true, id: rows[0].id, kind };
  const existing = await pool.query(
    `SELECT id, kind FROM app.job_escalations
      WHERE client_id = $1 AND kind = $2 AND acted_on_at IS NULL LIMIT 1`,
    [clientId, kind]
  );
  return { raised: false, id: existing.rows[0]?.id ?? null, kind };
}

export async function markEscalationActed(pool, escalationId, action) {
  const { rowCount } = await pool.query(
    `UPDATE app.job_escalations SET acted_on_at = now(), action = $2
      WHERE id = $1 AND acted_on_at IS NULL`,
    [escalationId, action]
  );
  return rowCount === 1;
}

/**
 * Should the loop say anything at all right now?
 *
 * The cadence here is policy and is meant to be changeable without a migration.
 * The hard rule - one open question - is the index, not this function.
 *
 * `quiet` is hours the candidate has asked not to be written to, which is why
 * progress is deferred but an urgent event is not: nobody wants to be woken for
 * a status update, and everybody wants to be woken for an offer.
 */
export function notWorthSending({ open, cadenceHours, lastSentAt, now, urgent = false, quiet = null }) {
  // Urgent bypasses every preference below, not just the open question. This is
  // the bug the cadence check caught: an offer arriving twenty minutes after a
  // progress note was being held back by the 24h rule, which is precisely the
  // message the candidate most needs to see. Cadence exists to stop Jobby being
  // tedious. An offer is not tedious, and a loop that lets the preference win
  // over the event has quietly decided the candidate does not need to know.
  if (urgent) return { send: true, reason: 'urgent: cadence and quiet hours do not apply' };

  if (open) {
    return { send: false, reason: 'a question is already unanswered and waiting for a reply' };
  }
  if (quiet && inQuietHours(now, quiet)) {
    return { send: false, reason: 'inside the quiet hours the candidate asked for' };
  }
  if (!lastSentAt) return { send: true, reason: 'first note' };
  const hours = (now.getTime() - new Date(lastSentAt).getTime()) / 36e5;
  if (hours < cadenceHours) {
    return { send: false, reason: `last note was ${Math.round(hours)}h ago, cadence is ${cadenceHours}h` };
  }
  return { send: true, reason: `cadence elapsed (${Math.round(hours)}h since the last one)` };
}

export function inQuietHours(now, quiet) {
  if (!quiet || quiet.from === undefined || quiet.to === undefined) return false;
  const h = now.getHours();
  const { from, to } = quiet;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/**
 * Write the check-in.
 *
 * This records the INTENTION before anything is sent, and it does that on
 * purpose. The alternative - send, then record - has a window in which the
 * mail has gone out and the database does not know, and a window like that is
 * how an agent sends the same thing twice during a restart. The row is created
 * open, so the index protects the send itself, not just the record of it.
 *
 * `send` is injected. The transport is Resend today and may be WhatsApp or
 * LinkedIn tomorrow; nothing above this line knows or cares which.
 */
export async function openCheckinWith({ pool, clientId, kind, decision, reason, to, from, subject, body, urgent = false, send }) {
  if (!CHECKIN_KINDS.includes(kind)) {
    return { ok: false, status: 'refused', error: `unknown check-in kind '${kind}'` };
  }
  if (!body || !String(body).trim()) {
    // An empty note is the failure mode that looks most like working. If the
    // loop has nothing to say it must say nothing, not send a blank.
    return { ok: false, status: 'refused', error: 'a check-in with no body would be a blank email' };
  }
  if (!to || !from) {
    return { ok: false, status: 'refused', error: 'a check-in needs a real from and to address' };
  }

  // An urgent note SUPERSEDES an open question rather than queueing behind it.
  //
  // Without this the anti-spam index does the wrong thing at the worst possible
  // moment: Jobby asks which track to prioritise, the candidate does not answer
  // for two days, and an offer arrives. The index refuses a second check-in -
  // correctly, by its own rule - and the candidate never hears about the offer
  // until they answer a question that has stopped mattering.
  //
  // So the question is closed first. It is not deleted and it is not marked
  // answered: `still_open` goes false with no `answered_at`, which means the
  // record says plainly that nobody replied AND that we stopped waiting. Those
  // are different facts and the row keeps both.
  let supersededId = null;
  if (urgent) {
    const prev = await pool.query(
      `UPDATE app.job_checkins SET still_open = false
        WHERE client_id = $1 AND still_open
        RETURNING id`,
      [clientId]
    );
    supersededId = prev.rows[0]?.id ?? null;
  }

  let rowId = null;
  let supersededForRollback = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO app.job_checkins
         (client_id, kind, decision, reason, from_address, to_address, subject, body, urgent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [clientId, kind, decision ?? null, reason ?? null, from, to, subject ?? null, body, urgent]
    );
    rowId = rows[0].id;
  } catch (e) {
    // The index firing is a correct refusal, not a malfunction. It is the whole
    // point, so it is reported as a decision and not as an error to retry.
    if (/job_checkins_one_open_idx/.test(e.message)) {
      return {
        ok: false, status: 'declined',
        error: 'a question is already open for this client; the database refused a second one',
      };
    }
    throw e;
  }

  if (typeof send === 'function') {
    try {
      const sent = await send({ to, from, subject, body, kind, urgent });
      if (sent && sent.ok === false) {
        await pool.query(`UPDATE app.job_checkins SET still_open = false WHERE id = $1`, [rowId]);
        if (supersededId) await restoreSuperseded(pool, supersededId);
        return { ok: false, status: 'not_sent', error: sent.error || 'transport refused it', id: rowId };
      }
      return { ok: true, status: 'sent', id: rowId, supersededId };
    } catch (e) {
      // The row is closed rather than left open: a transport failure is not an
      // unanswered question, and leaving it open would suppress every future
      // note as though the candidate had simply not replied yet.
      await pool.query(`UPDATE app.job_checkins SET still_open = false WHERE id = $1`, [rowId]);
      // ...and a superseded question comes back, because the candidate now has
      // neither the urgent news nor a question the loop is still waiting on. The
      // escalation is recorded separately, so the next tick retries the offer;
      // this only restores the state we took away.
      if (supersededId) await restoreSuperseded(pool, supersededId);
      return { ok: false, status: 'not_sent', error: String(e?.message || e), id: rowId };
    }
  }
  // supersededId is reported on every path, not just the sent one. The
  // verification caught the missing half: the supersede itself worked, exactly
  // one check-in stayed open, and the caller still had no idea it had displaced
  // a question the candidate was in the middle of answering.
  return { ok: true, status: 'recorded', id: rowId, supersededId };
}

/**
 * Put back a question that was superseded by an urgent note which then failed
 * to send.
 *
 * Scoped to the row and to `still_open = false AND answered_at IS NULL`, so it
 * can only ever restore something we ourselves took away moments ago. It cannot
 * resurrect a question the candidate actually answered, and it cannot reopen
 * anything that was closed for any other reason.
 */
async function restoreSuperseded(pool, checkinId) {
  const { rowCount } = await pool.query(
    `UPDATE app.job_checkins SET still_open = true
      WHERE id = $1 AND still_open = false AND answered_at IS NULL`,
    [checkinId]
  );
  return rowCount === 1;
}

/** The candidate replied. Close the question so the loop can speak again. */
export async function answerCheckin(pool, clientId, text) {
  const { rows } = await pool.query(
    `UPDATE app.job_checkins
        SET answered_at = now(), answered_text = $2, still_open = false
      WHERE client_id = $1 AND still_open
      RETURNING id, kind, decision`,
    [clientId, text ?? null]
  );
  return rows[0] || null;
}

/**
 * What may the loop do, given what state it is in?
 *
 * This is the wait, expressed as a rule the decision function can read.
 *
 * The ordering is the whole argument. An urgent event outranks the open
 * question, because the open question is us asking and the event is the world
 * changing. An open question outranks all ordinary work, because the candidate
 * has not asked for the next piece of work yet - continuing to push work while
 * asking a question is how an agent talks past somebody.
 */
export function loopPosture({ open, escalations, now, cadenceHours = 24, lastSentAt = null, quiet = null }) {
  if (Array.isArray(escalations) && escalations.length > 0) {
    return {
      posture: 'escalate',
      reason: `${escalations.length} event(s) need action now: ${escalations.map((e) => e.kind).join(', ')}`,
      mayWork: true,
    };
  }
  if (open) {
    return {
      posture: 'waiting',
      reason: `asked the candidate something ${open.kind === 'urgent' ? 'urgent' : ''} at ${open.sent_at} and has not been answered`.trim(),
      mayWork: false,
    };
  }
  const gate = notWorthSending({ open: null, cadenceHours, lastSentAt, now, urgent: false, quiet });
  return {
    posture: gate.send ? 'report' : 'work',
    reason: gate.send
      ? 'nothing outstanding and the cadence has elapsed, so it is time to report'
      : `nothing outstanding; ${gate.reason}`,
    mayWork: true,
  };
}
