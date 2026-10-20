#!/usr/bin/env node
// Apply the cycles migration, then verify the schema rather than reporting success.
//
// The two things this migration promises are a lease that excludes, and a cycle
// log that cannot record a failed run as a success. Both are verified by being
// violated, because a CREATE TABLE that ran is not the same as a constraint that
// holds - and the lease checks call the real tryLease() rather than restating its
// SQL, because a verification that tests a copy of a statement is a comment.
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  let failed = 0;
  const ok = (label, cond, extra = '') => {
    if (cond) console.log('    PASS  ' + label);
    else { failed += 1; console.log('    FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
  };

  const sql = readFileSync(join(here, '..', 'migrations', 'jobby_008_cycles.sql'), 'utf8');
  const client = await pool.connect();
  try {
    // Without these, DDL that cannot get its lock waits forever and the script
    // dies on a timeout with no output at all, which is indistinguishable from a
    // script that hung for no reason. A migration that blocks should say so.
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '60s'");
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('\n  migration applied');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('  migration FAILED:', e.message);
    await pool.end();
    process.exit(1);
  } finally {
    client.release();
  }

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='app' AND table_name IN ('job_cycles','job_cycle_leases') ORDER BY 1`
  );
  console.log('\n  tables created: %s', tables.rows.map(r => r.table_name).join(', ') || '(none)');
  ok('both tables exist', tables.rows.length === 2);

  const cons = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid IN ('app.job_cycles'::regclass, 'app.job_cycle_leases'::regclass)
      ORDER BY conname`
  );
  const names = cons.rows.map(r => r.conname);
  console.log('\n  constraints (%d): %s', names.length, names.join(', '));
  ok('an unavailable cycle cannot be recorded as ok', names.includes('job_cycles_unavailable_not_ok'));
  ok('an errored cycle cannot be recorded as ok', names.includes('job_cycles_error_not_ok'));
  ok('the status vocabulary is closed', names.includes('job_cycles_status_known'));

  const owner = await pool.query(
    `INSERT INTO app.job_clients (session_key, display_name, daily_send_cap)
     VALUES ('verify-cycles-' || floor(random()*1e9)::text, 'Cycle Verify', 15)
     ON CONFLICT (session_key) DO UPDATE SET display_name = 'Cycle Verify'
     RETURNING id`
  );
  const clientId = owner.rows[0].id;

  // The constraints, violated.
  try {
    await pool.query(
      `INSERT INTO app.job_cycles (client_id, worker_id, status, ok, finished_at)
       VALUES ($1, 'verify', 'unavailable', true, now())`, [clientId]);
    ok('inserting unavailable + ok:true is refused', false, 'the CHECK did not fire');
  } catch (e) {
    ok('inserting unavailable + ok:true is refused', /job_cycles_unavailable_not_ok/.test(e.message), e.message);
  }

  try {
    await pool.query(
      `INSERT INTO app.job_cycles (client_id, worker_id, status, ok, finished_at)
       VALUES ($1, 'verify', 'bogus_status', false, now())`, [clientId]);
    ok('an unknown status is refused', false, 'the CHECK did not fire');
  } catch (e) {
    ok('an unknown status is refused', /job_cycles_status_known/.test(e.message), e.message);
  }

  // The lease, exercised the way two workers would, through the real module.
  // pathToFileURL, not a bare path: on Windows the ESM loader rejects 'C:\...'
  // as a specifier, and the failure reads as a missing module rather than as a
  // path-format problem.
  const loopUrl = pathToFileURL(join(here, '..', 'jobby', 'loop.mjs')).href;
  const { tryLease, releaseLease } = await import(loopUrl);

  ok('a first worker takes a free lease', await tryLease(pool, clientId, 'worker-a'));
  ok('a second worker cannot take a live lease', (await tryLease(pool, clientId, 'worker-b')) === false);
  ok('the holder may renew its own lease', await tryLease(pool, clientId, 'worker-a'));

  // Recovery from a crashed worker is tested with a genuinely short lease rather
  // than by back-dating expires_at. Back-dating is refused by
  // job_cycle_lease_expiry_is_future, which is correct - an already-dead lease
  // should not be creatable - so the honest way to reach that state is to let
  // one expire on its own.
  await pool.query(`DELETE FROM app.job_cycle_leases WHERE client_id = $1`, [clientId]);
  ok('a short lease is taken', await tryLease(pool, clientId, 'worker-a', 900));
  ok('...and is refused to others while live', (await tryLease(pool, clientId, 'worker-b', 900)) === false);
  await new Promise((r) => setTimeout(r, 1400));
  ok('an expired lease is recovered by another worker', await tryLease(pool, clientId, 'worker-b', 900));
  const nowHeld = await pool.query(
    `SELECT worker_id FROM app.job_cycle_leases WHERE client_id = $1`, [clientId]);
  ok('...and the holder has changed', nowHeld.rows[0]?.worker_id === 'worker-b', JSON.stringify(nowHeld.rows[0]));

  // The release path, which is how an operator force-frees a stuck worker.
  ok('the holder can release its lease', await releaseLease(pool, clientId, 'worker-b'));
  ok('a released lease is available again', await tryLease(pool, clientId, 'worker-c', 5000));

  // And the cycle log actually holds a row, which is the whole point of it.
  await pool.query(
    `INSERT INTO app.job_cycles (client_id, worker_id, status, ok, decision, reason, finished_at)
     VALUES ($1, 'verify', 'no_work', true, 'idle', 'verification row', now())`, [clientId]);
  const logged = await pool.query(
    `SELECT count(*)::int AS n FROM app.job_cycles WHERE client_id = $1`, [clientId]);
  ok('a no_work cycle is recorded', logged.rows[0].n === 1, JSON.stringify(logged.rows[0]));

  await pool.query(`DELETE FROM app.job_cycle_leases WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM app.job_clients WHERE id = $1`, [clientId]);

  console.log(failed === 0
    ? '\n  schema verified: the lease excludes, and a failed cycle cannot be recorded as a pass'
    : `\n  ${failed} check(s) failed`);
  process.exitCode = failed === 0 ? 0 : 1;
  await pool.end();
}

main().catch((e) => { console.error('  ' + e.message); process.exit(1); });
