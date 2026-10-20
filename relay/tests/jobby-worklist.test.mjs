/**
 * relay/tests/jobby-worklist.test.mjs — the plan, and the loop that works it
 *
 * Two defects are covered here, both found on 2026-10-17 by asking what the
 * running system was doing rather than by reading it.
 *
 * 1. THE LOOP NEVER RECORDED A SUCCESSFUL CYCLE. 543 cycles had run. All 543
 *    were status='unavailable', ok=false, with the error
 *    `new row for relation "job_cycles" violates check constraint
 *    "job_cycles_settled_has_a_time"`. runCycle computed finishedAt and then
 *    did not pass it to recordCycle, so every cycle whose status was 'ran' or
 *    'no_work' was refused by its own constraint, fell into the catch block,
 *    and was re-recorded as 'unavailable' saying "the cycle could not read the
 *    client state". It had not failed to read anything. It had failed to write
 *    down that it had succeeded.
 *
 * 2. THE LOOP NEVER CONSULTED THE PLAN. plan.mjs built 15-20 prioritised
 *    actions per candidate and chat.mjs persisted them to app.job_actions. The
 *    heartbeat decided from six counts and then iterated an empty steps object,
 *    so it decided "source" every cycle and performed nothing.
 *
 * The rule both of these break: a check that could not run is never a pass. A
 * queue that could not be built is not an empty queue.
 */
import pg from 'pg';
import { runCycle, createHeartbeat, decide } from '../jobby/loop.mjs';
import { syncWorklist, nextAction, classifyAction, worklistCounts } from '../jobby/worklist.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL,
});

const CLIENT = 99201;
const GHOST = 99202;
const WORKER = 'worklist-test';

const dossier = {
  name: 'Worklist Verify',
  not_stated: ['phone', 'location', 'current_title', 'current_company', 'target_roles'],
  target_roles: ['Field Service Technician'],
  employment: [{ title: 'Photographer', company: 'Self', current: true }],
};

async function makeClient(id, name) {
  const { rows } = await pool.query(
    `INSERT INTO app.job_clients (id, display_name, session_key)
     VALUES ($1::int, $2, $3)
     ON CONFLICT (id) DO UPDATE SET display_name = $2
     RETURNING id`,
    [id, name, 'wl-test-' + id]);
  return rows[0].id;
}

async function cleanup() {
  await pool.query(
    `DELETE FROM app.job_actions WHERE client_id IN ($1,$2)`, [CLIENT, GHOST]);
  await pool.query(
    `DELETE FROM app.job_dossiers WHERE client_id IN ($1,$2)`, [CLIENT, GHOST]);
  await pool.query(
    `DELETE FROM app.job_cycles WHERE worker_id LIKE 'wl-test%'`);
  await pool.query(
    `DELETE FROM app.job_cycle_leases WHERE worker_id LIKE 'wl-test%'`);
  await pool.query(
    `DELETE FROM app.job_clients WHERE id IN ($1,$2)`, [CLIENT, GHOST]);
}

try {
  await cleanup();
  const clientId = await makeClient(CLIENT, 'Worklist Verify');
  const ghostId = await makeClient(GHOST, 'No Dossier');
  await pool.query(
    `INSERT INTO app.job_dossiers (client_id, dossier) VALUES ($1,$2::jsonb)`, [clientId, JSON.stringify(dossier)]);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- a cycle that settles must be recordable ---');
  {
    // The constraint itself. If this insert is accepted the constraint is
    // broken; if it is refused the constraint is doing its job.
    let refusedNullFinish = false;
    try {
      await pool.query(
        `INSERT INTO app.job_cycles (client_id, worker_id, status, ok, steps)
         VALUES ($1,$2,'no_work',true,'[]'::jsonb)`, [clientId, WORKER + '-probe']);
    } catch (e) {
      refusedNullFinish = /job_cycles_settled_has_a_time/.test(String(e.message));
    }
    check('a no_work cycle with no finished_at is refused by the database',
      refusedNullFinish, 'the constraint did not fire');

    await pool.query(`DELETE FROM app.job_cycles WHERE worker_id = $1`, [WORKER + '-probe']);

    const r = await runCycle({ pool, clientId, workerId: WORKER, steps: {} });
    check('runCycle on a settled decision reports no_work, not unavailable',
      r.status === 'no_work' && r.ok === true, `got ${r.status}/${r.ok}`);
    check('runCycle returns a cycleId (the write succeeded)', !!r.cycleId);

    const row = await pool.query(
      `SELECT status, ok, finished_at IS NOT NULL AS fin FROM app.job_cycles WHERE id = $1`, [r.cycleId]);
    check('the recorded row carries finished_at',
      row.rows[0]?.fin === true, JSON.stringify(row.rows[0]));
    check('the recorded row says no_work, not unavailable',
      row.rows[0]?.status === 'no_work', row.rows[0]?.status);
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- a failing cycle names the phase that failed ---');
  {
    const r = await runCycle({
      pool, clientId, workerId: WORKER + '-fail',
      steps: { boom: { run: async () => { throw new Error('step exploded'); } } },
    });
    check('a throwing step is caught and the cycle continues',
      r.status === 'error' && r.ok === false, `got ${r.status}/${r.ok}`);
    check('the failing step is recorded by name',
      r.steps?.some(s => s.step === 'boom' && s.note === 'step exploded'),
      JSON.stringify(r.steps));
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the plan is a queue, and it refuses to be an empty one ---');
  {
    const g = await syncWorklist(pool, ghostId);
    check('a client with no dossier gets ok:false, not an empty list',
      g.ok === false, `ok=${g.ok}`);
    check('and is told why', typeof g.reason === 'string' && g.reason.length > 0, g.reason);

    const s1 = await syncWorklist(pool, clientId);
    check('a client with a dossier gets a real plan', s1.ok === true, s1.reason);
    check('the plan has more than one action', (s1.actions?.length || 0) > 1, `${s1.actions?.length}`);
    check('every action carries a priority',
      s1.actions.every(a => Number.isInteger(a.priority)));
    check('every action carries a title',
      s1.actions.every(a => typeof a.title === 'string' && a.title.trim().length > 0));

    const counts = await worklistCounts(pool, clientId);
    check('the open count matches the plan', counts.open === s1.actions.length,
      `${counts.open} vs ${s1.actions.length}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- syncing twice does not duplicate, and does not forget ---');
  {
    const before = (await pool.query(
      `SELECT count(*)::int n FROM app.job_actions WHERE client_id=$1`, [clientId])).rows[0].n;
    const s2 = await syncWorklist(pool, clientId);
    const after = (await pool.query(
      `SELECT count(*)::int n FROM app.job_actions WHERE client_id=$1`, [clientId])).rows[0].n;
    check('a repeat sync inserts nothing', s2.inserted === 0, `inserted ${s2.inserted}`);
    check('a repeat sync changes no row count', before === after, `${before} -> ${after}`);

    // The old replaceActions() did DELETE-pending then re-INSERT, which turned
    // completed work back into pending work. Prove that no longer happens.
    const n1 = await nextAction(pool, clientId);
    await pool.query(`UPDATE app.job_actions SET status='done' WHERE id=$1`, [n1.id]);
    await syncWorklist(pool, clientId);
    const st = (await pool.query(
      `SELECT status FROM app.job_actions WHERE id=$1`, [n1.id])).rows[0].status;
    check('a completed action is not reopened by a re-sync', st === 'done', st);

    const n2 = await nextAction(pool, clientId);
    check('the next action is a different one', n2 && n2.id !== n1.id,
      n2 ? `still ${n2.title}` : 'none left');
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the loop refuses to tick off the candidate\'s work ---');
  {
    const cases = [
      ['Confirm your target roles and rate floor', 'candidate'],
      ['Close 5 gaps in your dossier', 'candidate'],
      ['Get the certifications the roster actually names', 'candidate'],
      ['Lock the canonical application packet', 'agent'],
      ['Source 25 fifo opportunities', 'agent'],
      ['A task shape nobody anticipated', 'candidate'],
    ];
    for (const [title, want] of cases) {
      const got = classifyAction(title, '').who;
      check(`classify "${title.slice(0, 42)}" -> ${want}`, got === want, `got ${got}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the heartbeat runs a step ---');
  {
    const steps = {
      worklist: {
        run: async ({ clientId }) => {
          const sync = await syncWorklist(pool, clientId);
          if (!sync.ok) return { ok: false, note: sync.reason };
          const n = await nextAction(pool, clientId);
          return { ok: true, note: n ? `next: ${n.title}` : 'nothing open' };
        },
      },
    };
    const lines = [];
    const hb = createHeartbeat({ pool, workerId: WORKER + '-hb', steps, log: m => lines.push(m) });
    await hb.tick();

    const mine = lines.filter(l => l.startsWith(String(clientId) + ' '));
    check('the heartbeat logged the cycle for the dossier client', mine.length === 1,
      mine.join(' | '));
    check('and the log names the step that ran',
      mine[0]?.includes('worklist:ok'), mine[0]);
    check('the client with no dossier is reported as an error, not a pass',
      lines.some(l => l.startsWith(String(ghostId) + ' ') && l.includes('worklist:FAIL')),
      lines.find(l => l.startsWith(String(ghostId) + ' ')));
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- decide() is still deterministic ---');
  {
    const a = decide({ pipelineDepth: 0 });
    const b = decide({ pipelineDepth: 0 });
    check('the same counts give the same decision', a.decision === b.decision && a.reason === b.reason);
  }
} catch (e) {
  failures += 1;
  console.log('  FAIL  suite threw: ' + (e && e.stack ? e.stack : e));
} finally {
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(failures === 0
  ? '\njobby-worklist: all checks passed'
  : `\njobby-worklist: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);