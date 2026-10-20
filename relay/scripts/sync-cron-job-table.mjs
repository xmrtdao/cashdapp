/**
 * scripts/sync-cron-job-table.mjs — reconcile cron.job with cron-jobs.json
 *
 * WHY
 *
 * loadJobsFromPg() reads cron.job, and only falls back to relay-data/cron-jobs.json
 * when cron.job is EMPTY. So the moment cron.job has a single row in it, the
 * 84 hand-maintained jobs in the JSON - including 303 jobby-heartbeat, 304 the
 * morning summary and 305 the evening summary - stop being scheduled, and
 * nothing says so. The daemon logs "loaded 35 jobs" and looks healthy.
 *
 * That is the same shape of bug as everything else in this file: a silent
 * fallback in the wrong direction. A fallback should be additive, not a
 * replacement, and the count it loads should be the count it runs.
 *
 * THIS SCRIPT (safe to re-run)
 *
 *   1. Applies the chat-dedupe cadences to cron.job, because those two jobs
 *      live in BOTH sources and cron.job is the one actually driving them.
 *      (The old cadences are written out in words rather than as cron
 *      expressions: a literal star-slash inside a block comment ends the
 *      comment, which is a wonderfully boring way to lose a script.)
 *        id 5  task-discussion-announcer  every 15 min -> :07 and :37
 *        id 13 task-nudge                 :00 and :30 -> hourly at :17
 *      Plus the new task-nudge limits, which are read from the environment by
 *      task-nudge.mjs and are set in CRON_JOB_ENV below so the scheduled
 *      process gets them rather than only an interactive shell.
 *
 *   2. Inserts any job that exists in cron-jobs.json but not in cron.job, so
 *      the Jobby jobs are actually scheduled.
 *
 *   3. Reports shadowing in both directions and exits non-zero on a conflict
 *      it had to guess about.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOBS_FILE = join(__dirname, '..', '..', 'relay-data', 'cron-jobs.json');

// cron.job is the source that is actually running, so the anti-spam cadences
// have to land here as well as in the JSON.
const RETUNE = {
  5:  { name: 'task-discussion-announcer', to: '7,37 * * * *' },
  13: { name: 'task-nudge',                to: '17 * * * *' },
  227: { name: 'fleet-chat-task-creator',   to: '17,47 * * * *' },
};

const pool = new pg.Pool({ connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL });
let exitCode = 0;

try {
  const json = JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
  const jobs = Array.isArray(json) ? json : (json.jobs || Object.values(json).flat());

  const have = await pool.query('SELECT id, name, schedule, enabled, command FROM cron.job ORDER BY id');
  const byId = new Map(have.rows.map(r => [Number(r.id), r]));

  // ── 1. retune ────────────────────────────────────────────────────────
  for (const [idStr, want] of Object.entries(RETUNE)) {
    const id = Number(idStr);
    const row = byId.get(id);
    if (!row) { console.log(`[sync] ${id} ${want.name}: not in cron.job, skipped`); continue; }
    if (row.schedule === want.to) { console.log(`[sync] ${id} ${want.name}: already ${want.to}`); continue; }
    await pool.query('UPDATE cron.job SET schedule = $2 WHERE id = $1', [id, want.to]);
    console.log(`[sync] ${id} ${want.name}: ${row.schedule}  ->  ${want.to}`);
  }

  // ── 2. insert what is missing ────────────────────────────────────────
  const inserted = [];
  for (const j of jobs) {
    const id = Number(j.id);
    if (byId.has(id)) continue;

    // cron.job has no `type` column, so a job's kind has to live in its
    // command. JSON `local` jobs become `node -e` one-liners; `sql` jobs use
    // their sql; `ef` jobs cannot be expressed here and are reported.
    if (j.type === 'ef') { inserted.push({ id, skipped: 'edge function has no cron.job representation' }); continue; }

    let command = '';
    if (j.type === 'sql' && j.sql) command = j.sql;
    else if (j.type === 'local' && j.action) command = `node -e "import('./relay/cron-engine-v2.mjs').then(m=>m.runLocalJob&&m.runLocalJob('${j.action}'))"`;
    else if (j.type === 'script') command = j.command || j.script || '';
    if (!command) { inserted.push({ id, skipped: 'no command derivable (' + j.type + ')' }); continue; }

    await pool.query(
      'INSERT INTO cron.job (name, schedule, command, enabled) VALUES ($1,$2,$3,$4)',
      [j.name || ('job-' + id), j.schedule, command, true]
    );
    console.log(`[sync] inserted ${id} ${j.name} (${j.type}) ${j.schedule}`);
    inserted.push({ id, type: j.type, name: j.name, schedule: j.schedule });
  }

  // ── 3. report shadowing ─────────────────────────────────────────────
  const jsonIds = new Set(jobs.map(j => Number(j.id)));
  const tableOnly = have.rows.filter(r => !jsonIds.has(Number(r.id)));
  const jsonOnly = jobs.filter(j => !byId.has(Number(j.id)));

  const after = await pool.query('SELECT id, name, schedule, enabled FROM cron.job ORDER BY id');
  console.log(`\n[sync] cron.job rows before=${have.rowCount} after=${after.rowCount}`);
  console.log(`[sync] in cron-jobs.json only: ${jsonOnly.length} (${jsonOnly.slice(0, 12).map(j => j.id).join(', ')}${jsonOnly.length > 12 ? ', ...' : ''})`);
  console.log(`[sync] in cron.job only:        ${tableOnly.length} (${tableOnly.slice(0, 12).map(r => r.id + ':' + r.name).join(', ')}${tableOnly.length > 12 ? ', ...' : ''})`);

  const skipped = inserted.filter(i => i.skipped);
  if (skipped.length) {
    console.log(`\n[sync] NOT inserted (need a decision, not a guess):`);
    for (const s of skipped) console.log(`  ${s.id}: ${s.skipped}`);
    exitCode = 1;
  }

  const jobby = after.rows.filter(r => /jobby/i.test(r.name || ''));
  console.log(`\n[sync] jobby rows now in cron.job:`);
  if (!jobby.length) console.log('  (none)');
  for (const j of jobby) console.log(`  ${String(j.id).padEnd(5)} ${j.enabled === false ? 'OFF' : 'on '} ${String(j.schedule).padEnd(16)} ${j.name}`);
} catch (e) {
  console.error('[sync] FAIL: ' + e.message);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);