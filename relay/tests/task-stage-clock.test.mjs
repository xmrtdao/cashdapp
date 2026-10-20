// A task's clock must run.
//
// app.tasks has two columns that only mean anything together:
//
//   stage_started_at            when the task entered its current stage
//   auto_advance_threshold_hours how long it may sit there
//
// The auto-advance reads the first and writes the second. Before this test
// existed, stage_started_at was written in exactly one place - a relay
// endpoint that changes a task's stage by hand. Nothing set it when a task
// was CREATED, so a task filed through the fleet chat had no clock from the
// moment it was born.
//
// The auto-advance's progress pass skips tasks with no clock:
//
//   .not('stage_started_at', 'is', null)
//
// so their checklist was never counted, their progress stayed at zero, and
// they never reached the 100% the advance pass needs. Sixteen of the
// seventeen open tasks were invisible to both passes. They were not stalled
// by a rule: they were invisible to one.
//
// And the scheduled job asked for the advance-only action, so even with a
// clock nothing ever counted the checklist. The function has a "run_all"
// action that does both; nothing called it.
//
// Runs against the throwaway test database (see tests/_run.mjs).

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '..');

const DB = process.env.LOCAL_DATABASE_URL
  || process.env.LOCAL_PG_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite_test';

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = (sql, params) => client.query(sql, params);

const made = [];
let seq = 0;
async function makeTask(stage) {
  seq++;
  const id = `test-clock-${Date.now()}-${seq}`;
  await q(
    `insert into app.tasks (id, title, stage, status, priority, created_at, updated_at)
     values ($1, $2, $3, 'PENDING', 0, now(), now())`,
    [id, `CLOCK TEST ${seq}`, stage]);
  made.push(id);
  return id;
}

section('a task that has a stage has a clock');
{
  const id = await makeTask('PENDING');
  const row = await q(`select stage_started_at from app.tasks where id = $1`, [id]);
  check('a task filed with a stage gets a clock', row.rows[0].stage_started_at !== null,
    row.rows[0].stage_started_at);
}

section('a task that moves stage gets a new clock');
{
  const id = await makeTask('PENDING');
  const before = await q(`select stage_started_at from app.tasks where id = $1`, [id]);
  await q(`update app.tasks set stage = 'DISCUSS' where id = $1`, [id]);
  const after = await q(`select stage_started_at from app.tasks where id = $1`, [id]);
  check('the clock restarts when the stage changes',
    new Date(after.rows[0].stage_started_at) > new Date(before.rows[0].stage_started_at),
    `${before.rows[0].stage_started_at} -> ${after.rows[0].stage_started_at}`);
}

section('and the scheduled job counts the checklist');
{
  // The advance pass advances a task whose checklist progress has reached
  // 100%. The progress pass is what turns a checklist into a number. Asking
  // for the advance-only action means the checklist is never counted, so no
  // task ever reaches 100% and no task ever advances - while the job reports
  // itself as healthy, running every ten minutes, zero rows.
  const raw = JSON.parse(readFileSync(join(RELAY, '..', 'relay-data', 'cron-jobs.json'), 'utf8'));
  const jobs = Array.isArray(raw) ? raw : (raw.jobs || Object.values(raw).flat());
  const job = jobs.find((j) => j.fn === 'task-auto-advance');
  check('the scheduled auto-advance job exists', !!job, job?.name);
  if (job) {
    check('and it asks for both passes, not the advance alone',
      job.body && job.body.action === 'run_all', JSON.stringify(job.body));
  }
}

// cleanup
for (const id of made) {
  await q(`delete from app.tasks where id = $1`, [id]).catch(() => {});
}
await client.end();

console.log(fails === 0
  ? '\nall checks passed'
  : `\n${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
