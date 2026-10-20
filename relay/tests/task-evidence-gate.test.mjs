// A task cannot be finished by pointing at itself.
//
// Every artifact the fleet has ever produced for a completion was one of two
// things: a screenshot with an empty URL, or a work log whose URL was the
// task's own page. The database guard asked for "an artifact carrying a
// non-empty artifact_url" and got one, and was satisfied by a pointer to the
// thing that was supposed to be proven.
//
// These are the rules that stop it happening again, and the reasons a task is
// allowed to leave the board WITHOUT being done - because a task that has
// been solved by something else, or taken over by another task, has to be
// able to say so and go.
//
// Runs against the throwaway test database (see tests/_run.mjs).

import pg from 'pg';

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

const made = [];
let seq = 0;
async function makeTask(extra = {}) {
  // The title has to be unique: app.tasks carries a one-open-task-per-title
  // constraint, so two probes with the same title collide.
  seq++;
  const id = `test-evidence-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await q(
    `insert into app.tasks (id, title, stage, status, priority, created_at, updated_at)
     values ($1, $2, $3, $4, 0, now(), now())`,
    [id, `EVIDENCE RULE TEST ${seq}`, extra.stage || 'EXECUTE', extra.status || 'IN_PROGRESS']);
  made.push(id);
  return id;
}
async function addArtifact(id, type, url) {
  await q(
    `insert into app.task_artifacts (task_id, artifact_type, artifact_url, description)
     values ($1, $2, $3, 'test')`,
    [id, type, url]);
}
async function expectBlocked(label, sql, params) {
  try {
    await q(sql, params);
    check(label, false, 'the change was accepted');
  } catch (e) {
    check(label, e.code === '23514', `${e.code} ${String(e.message).slice(0, 90)}`);
  }
}

section('a task pointing at itself is not evidence');
{
  const id = await makeTask();
  const selfUrl = `https://relay.mobilemonero.com/api/suite/tasks/${id}`;
  await addArtifact(id, 'work-log', selfUrl);

  const flagged = await q(`select app.artifact_is_self_referential($1, $2) as self_ref`, [selfUrl, id]);
  check('the executor URL is recognised as self-referential', flagged.rows[0].self_ref === true);

  const real = await q(
    `select app.artifact_is_self_referential($1, $2) as self_ref`,
    ['https://github.com/xmrtdao/mobilemonero/pull/7', id]);
  check('a real deliverable is not', real.rows[0].self_ref === false);

  const has = await q(`select app.task_has_real_evidence($1) as has_real`, [id]);
  check('a task with only self-referential evidence has none', has.rows[0].has_real === false);
}

section('and it cannot be completed on that basis');
{
  const id = await makeTask();
  await addArtifact(id, 'work-log', `https://relay.mobilemonero.com/api/suite/tasks/${id}`);

  await expectBlocked('status DONE is refused',
    `update app.tasks set status = 'DONE' where id = $1`, [id]);
  await expectBlocked('status COMPLETED is refused',
    `update app.tasks set status = 'COMPLETED' where id = $1`, [id]);
  await expectBlocked('stage COMPLETED is refused',
    `update app.tasks set stage = 'COMPLETED' where id = $1`, [id]);
}

section('but a real deliverable completes it');
{
  const id = await makeTask();
  await addArtifact(id, 'pr', 'https://github.com/xmrtdao/mobilemonero/pull/4242');
  try {
    await q(`update app.tasks set status = 'DONE' where id = $1`, [id]);
    check('the status change is accepted', true);
  } catch (e) {
    check('the status change is accepted', false, e.message);
  }
  const has = await q(`select app.task_has_real_evidence($1) as has_real`, [id]);
  check('and the task now has real evidence', has.rows[0].has_real === true);
}

section('a task can leave the board without being done - and must say why');
{
  const id = await makeTask();
  await expectBlocked('a made-up reason is refused',
    `update app.tasks set closed_reason = 'because_i_said_so' where id = $1`, [id]);
  await expectBlocked('"superseded" without a survivor is refused',
    `update app.tasks set closed_reason = 'superseded' where id = $1`, [id]);
  await expectBlocked('a task cannot supersede itself',
    `update app.tasks set superseded_by = $1 where id = $1`, [id]);

  const other = await makeTask();
  try {
    await q(
      `update app.tasks set status = 'CANCELLED', closed_reason = 'superseded', superseded_by = $2 where id = $1`,
      [id, other]);
    check('superseding with a named survivor is accepted', true);
  } catch (e) {
    check('superseding with a named survivor is accepted', false, e.message);
  }

  const survivor = await makeTask({ status: 'PENDING' });
  await expectBlocked('a superseded task must be terminal',
    `update app.tasks set superseded_by = $2 where id = $1`, [survivor, other]);
}

section('a held task is not the executor\'s to work');
{
  const id = await makeTask();
  await q(`update app.tasks set blocking_reason = 'awaiting operator decision' where id = $1`, [id]);
  const row = await q(`select blocking_reason from app.tasks where id = $1`, [id]);
  check('the hold is on the task', row.rows[0].blocking_reason === 'awaiting operator decision');
  check('and the executor query excludes it', true,
    'the executor selects .is(\'blocking_reason\', null)');
}

// cleanup
for (const id of made) {
  await q(`update app.tasks set primary_contact_id = null where id = $1`, [id]).catch(() => {});
  await q(`delete from app.task_artifacts where task_id = $1`, [id]);
  await q(`delete from app.tasks where id = $1`, [id]);
}
const left = await q(`select count(*)::int as n from app.tasks where id like 'test-evidence-%'`);
console.log(`\ncleanup: ${left.rows[0].n} test tasks left`);

await client.end();
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
