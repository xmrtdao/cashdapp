/**
 * relay/jobby/worklist.mjs — the plan, as a queue the loop actually works
 *
 * WHAT WAS WRONG
 *
 * plan.mjs builds fifteen to twenty prioritised actions per candidate from
 * their dossier. chat.mjs persisted them into app.job_actions on resume parse.
 * So the list existed, had statuses and priorities and track numbers, and was
 * surfaced in the session route, two agent tools, and both daily summary
 * emails.
 *
 * And then loop.mjs — the thing that runs every fifteen minutes — never once
 * read it. It decided what to do from six counts over job_opportunities,
 * job_applications and job_outreach. The planner and the executor were two
 * systems that shared a database and nothing else.
 *
 * That is why the answer to "is it getting anything done" was no. It was
 * deciding "source" every cycle, because the pipeline was empty, and never
 * consulting the list that said the first thing to do was to close five gaps
 * in the dossier.
 *
 * TWO THINGS THIS MODULE REFUSES TO DO
 *
 * 1. Invent a worklist. buildPlan() reads the dossier. No dossier means no
 *    plan, and the honest answer is "there is nothing to work from yet", not
 *    an empty queue that reads like "nothing to do". A check that could not run
 *    is never a pass, and an empty list is a claim.
 *
 * 2. Destroy progress. store.replaceActions() runs
 *    DELETE ... WHERE status='pending' followed by a re-INSERT of every
 *    action. Any action the candidate had completed since the last parse was
 *    recreated as pending, so re-parsing a resume silently un-did their work.
 *    syncWorklist() below updates in place and only inserts what is new.
 */

import { buildPlan } from './plan.mjs';
import { readCounts } from './loop.mjs';

/** Statuses that count as finished. Mirrors the loop's terminal set. */
const DONE = new Set(['done', 'complete', 'completed', 'skipped', 'wont_fix']);

/**
 * The candidate's plan, persisted and current.
 *
 * @returns {Promise<{ok: boolean, reason: string, actions?: Array, inserted?: number, updated?: number}>}
 *   ok:false means the list could not be determined. That is a finding, not an
 *   empty list, and callers must not read it as "no work".
 */
export async function syncWorklist(pool, clientId, { dossier = null, tracks = null } = {}) {
  const d = dossier ?? (await readDossier(pool, clientId));

  if (!d || (typeof d === 'object' && Object.keys(d).length === 0)) {
    return {
      ok: false,
      reason: 'no dossier on file yet, so there is no plan to work from',
    };
  }

  const plan = await buildPlan(d, { tracks });

  // What is already on file. Keyed on the title, because that is the only
  // stable identity an action has across regenerations — the id changes when a
  // resume is re-parsed, and matching on id would therefore re-insert
  // everything every time.
  const existing = await pool.query(
    `SELECT id, title, status, priority, track, detail
       FROM app.job_actions WHERE client_id = $1`,
    [clientId]
  );
  const byTitle = new Map(existing.rows.map(r => [String(r.title).trim().toLowerCase(), r]));

  let inserted = 0;
  let updated = 0;
  let completed = 0;

  for (const a of plan.actions) {
    const key = String(a.title).trim().toLowerCase();
    const prev = byTitle.get(key);

    if (!prev) {
      await pool.query(
        `INSERT INTO app.job_actions (client_id, track, title, detail, status, priority)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, a.track ?? null, a.title, a.detail ?? null, a.status ?? 'pending', a.priority ?? 3]
      );
      inserted++;
      continue;
    }

    // Keep what the candidate did; refresh what the plan knows. A finished
    // action is never reopened by a re-parse.
    const isDone = DONE.has(String(prev.status || '').toLowerCase());
    const detailChanged = (prev.detail || '') !== (a.detail || '');
    const priorityChanged = Number(prev.priority) !== Number(a.priority ?? 3);

    if (isDone) { completed++; continue; }

    if (detailChanged || priorityChanged) {
      await pool.query(
        `UPDATE app.job_actions
            SET detail = $3, priority = $4, track = $5, updated_at = now()
          WHERE id = $1 AND client_id = $2`,
        [prev.id, clientId, a.detail ?? null, a.priority ?? 3, a.track ?? null]
      );
      updated++;
    }
  }

  return {
    ok: true,
    reason: `${plan.actions.length} action(s) across ${plan.tracks.length} track(s)`,
    tracks: plan.tracks,
    actions: plan.actions,
    inserted,
    updated,
    completed,
  };
}

/** The dossier row for a client, or null. */
async function readDossier(pool, clientId) {
  const { rows } = await pool.query(
    `SELECT dossier FROM app.job_dossiers WHERE client_id = $1`,
    [clientId]
  );
  const raw = rows[0]?.dossier;
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * The one action to work on this cycle.
 *
 * Ordered the way the plan orders them: priority, then track (nulls first — an
 * action that belongs to no track is a cross-cutting one and usually gates the
 * rest), then oldest first, so an action that has been waiting since onboarding
 * outranks one added an hour ago at the same priority.
 *
 * Returns null when there is nothing pending. Null means "checked and empty",
 * which is a different statement from syncWorklist's ok:false.
 */
export async function nextAction(pool, clientId) {
  const { rows } = await pool.query(
    `SELECT id, track, title, detail, priority, status, created_at, updated_at
       FROM app.job_actions
      WHERE client_id = $1
        AND lower(coalesce(status,'pending')) NOT IN ('done','complete','completed','skipped','wont_fix')
      ORDER BY priority ASC, track ASC NULLS FIRST, updated_at ASC, id ASC
      LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

/** How many actions are still open. Cheap, and it goes in the summary email. */
export async function worklistCounts(pool, clientId) {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE lower(coalesce(status,'pending'))
                          NOT IN ('done','complete','completed','skipped','wont_fix'))::int AS open,
       count(*) FILTER (WHERE priority = 1
                          AND lower(coalesce(status,'pending'))
                          NOT IN ('done','complete','completed','skipped','wont_fix'))::int AS p1_open
     FROM app.job_actions WHERE client_id = $1`,
    [clientId]
  );
  return { open: rows[0]?.open ?? 0, p1Open: rows[0]?.p1_open ?? 0 };
}

/**
 * Can the loop do this action by itself?
 *
 * The plan is written for a human. "Confirm your target roles and rate floor"
 * is a thing only the candidate can do, and a loop that marks it done because
 * it read it would be manufacturing progress. So each action is classified, and
 * the ones that wait on a human are named as such rather than being quietly
 * skipped.
 *
 * Deliberately conservative: an action with no recognisable shape is treated as
 * candidate-only. A wrong 'agent' here means the loop does something to a
 * candidate's record that they did not ask for.
 */
export function classifyAction(title = '', detail = '') {
  const t = `${title} ${detail}`.toLowerCase();

  // Things only the candidate can settle: their rate, their targets, their
  // certifications, their answers to our questions.
  if (/\b(confirm|tell me|your rate|rate floor|what you hold|if that works for you|say so)\b/.test(t)) {
    return { who: 'candidate', why: 'needs an answer only the candidate has' };
  }
  // Things the loop builds from data it already has.
  if (/\b(lock the canonical application packet|one resume, one contact block)\b/.test(t)) {
    return { who: 'agent', why: 'built from the dossier, no candidate input needed' };
  }
  if (/\b(source|research each target)\b/.test(t)) {
    return { who: 'agent', why: 'sourcing is mechanical once the tracks are decided' };
  }
  return { who: 'candidate', why: 'not a shape the loop can safely complete unattended' };
}