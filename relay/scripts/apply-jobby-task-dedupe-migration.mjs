/**
 * Apply migrations/jobby_010_task_dedupe.sql and then PROVE the index works by
 * trying to create the duplicate it exists to prevent.
 *
 * A migration that only reports success is the failure mode this repo keeps
 * hitting, so this script asserts the constraint refuses a duplicate and then
 * cleans up after itself. If the duplicate goes in, this exits non-zero.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, '..', 'migrations', 'jobby_010_task_dedupe.sql');

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL,
});

const PROBE_TITLE = 'zz-dedupe-probe-' + Date.now();
let exitCode = 0;

try {
  const sql = readFileSync(MIGRATION, 'utf8');
  await pool.query(sql);
  console.log('[dedupe] migration applied');

  // ── Verify the index exists ───────────────────────────────────────────
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='app' AND tablename='tasks' AND indexname='tasks_one_open_per_title'`
  );
  if (idx.rowCount !== 1) throw new Error('tasks_one_open_per_title was not created');
  console.log('[dedupe] index tasks_one_open_per_title present');

  // ── Verify it refuses a duplicate ─────────────────────────────────────
  const mk = () =>
    pool.query(
      `INSERT INTO app.tasks (id, title, status, stage, priority, updated_at)
       VALUES ($1, $2, 'PENDING', 'DISCUSS', 3, now())`,
      ['probe-' + Math.random().toString(36).slice(2), PROBE_TITLE]
    );

  await mk();
  console.log('[dedupe] first open task with the title: accepted (correct)');

  let refused = false;
  try {
    await mk();
  } catch (e) {
    refused = /tasks_one_open_per_title/.test(e.message);
    console.log('[dedupe] second open task with the same title: ' +
      (refused ? 'REFUSED by the index (correct)' : 'refused, but NOT by our index: ' + e.message));
  }
  if (!refused) {
    console.error('[dedupe] FAILED: a duplicate open title was accepted');
    exitCode = 1;
  }

  // ── Verify a recurrence is still allowed once the first is DONE ───────
  await pool.query(`UPDATE app.tasks SET status='DONE' WHERE title=$1`, [PROBE_TITLE]);
  try {
    await mk();
    console.log('[dedupe] same title after the first was DONE: accepted (recurrence is allowed)');
  } catch (e) {
    console.error('[dedupe] FAILED: could not re-file a resolved incident: ' + e.message);
    exitCode = 1;
  }

  await pool.query(`DELETE FROM app.tasks WHERE title=$1`, [PROBE_TITLE]);
  console.log('[dedupe] probe rows removed');
} catch (e) {
  console.error('[dedupe] FAIL: ' + e.message);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);