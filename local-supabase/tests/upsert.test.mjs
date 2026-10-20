// Test the four upsert code paths in routes/rest.mjs against a running
// local-sb instance. Uses a temp table with a UNIQUE constraint we create
// at the top and drop at the bottom, so the test is self-contained.
//
// Run with: node tests/upsert.test.mjs

import pg from 'pg';
const { Client } = pg;

const BASE = process.env.LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = 'local-dev-service-role-key';

let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

async function rest(method, path, { body, prefer, anon } = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer': prefer || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function main() {
  // Bypass the REST router and talk to postgres directly to set up
  const admin = new Client({ connectionString: process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  await admin.connect();
  await admin.query(`
    DROP TABLE IF EXISTS upsert_test;
    CREATE TABLE upsert_test (
      id SERIAL PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log('Setup: created upsert_test table\n');

  // ── Test 1: Plain insert (no upsert) ────────────────────────────
  console.log('Test 1: plain POST (no on_conflict) inserts a new row');
  let r = await rest('POST', 'upsert_test', {
    body: { sku: 'A', name: 'alpha', count: 1 },
  });
  ok('plain insert returns 201', r.status === 201);
  ok('plain insert returns the row', Array.isArray(r.body) && r.body[0]?.sku === 'A');
  const before = await admin.query('SELECT count FROM upsert_test WHERE sku=$1', ['A']);
  ok('plain insert wrote count=1', before.rows[0].count === 1);

  // ── Test 2: Upsert with on_conflict URL param (merge-duplicates) ─
  console.log('\nTest 2: POST with ?on_conflict=sku merges (updates) the existing row');
  r = await rest('POST', 'upsert_test?on_conflict=sku', {
    body: { sku: 'A', name: 'alpha-updated', count: 5 },
  });
  ok('upsert returns 201', r.status === 201, JSON.stringify(r.body));
  const after = await admin.query('SELECT name, count FROM upsert_test WHERE sku=$1', ['A']);
  ok('name was updated', after.rows[0].name === 'alpha-updated', `got: ${after.rows[0].name}`);
  ok('count was updated', after.rows[0].count === 5);
  ok('only one row exists for sku=A',
    (await admin.query('SELECT count(*)::int AS n FROM upsert_test WHERE sku=$1', ['A'])).rows[0].n === 1);

  // ── Test 3: Upsert with new sku (should INSERT, not fail) ──────
  console.log('\nTest 3: upsert of a brand-new sku inserts a new row');
  r = await rest('POST', 'upsert_test?on_conflict=sku', {
    body: { sku: 'B', name: 'bravo', count: 2 },
  });
  ok('new-sku upsert returns 201', r.status === 201);
  const bRow = await admin.query('SELECT name FROM upsert_test WHERE sku=$1', ['B']);
  ok('new sku was inserted', bRow.rows[0]?.name === 'bravo');

  // ── Test 4: Prefer header merge-duplicates with on_conflict ─────
  console.log('\nTest 4: Prefer: resolution=merge-duplicates + on_conflict header');
  r = await rest('POST', 'upsert_test?on_conflict=sku', {
    body: { sku: 'A', name: 'alpha-via-prefer', count: 99 },
    prefer: 'resolution=merge-duplicates',
  });
  ok('prefer+on_conflict upsert returns 201', r.status === 201, JSON.stringify(r.body));
  const v2 = await admin.query('SELECT count FROM upsert_test WHERE sku=$1', ['A']);
  ok('prefer-header path also updates', v2.rows[0].count === 99);

  // ── Test 5: Prefer header merge-duplicates WITHOUT on_conflict ──
  console.log('\nTest 5: Prefer: resolution=merge-duplicates WITHOUT on_conflict → 400 PGRST114');
  r = await rest('POST', 'upsert_test', {
    body: { sku: 'A', name: 'x', count: 1 },
    prefer: 'resolution=merge-duplicates',
  });
  ok('returns 400', r.status === 400, `got ${r.status}`);
  ok('returns code PGRST114', r.body?.code === 'PGRST114', JSON.stringify(r.body));

  // ── Test 6: Prefer ignore-duplicates skips on conflict ──────────
  console.log('\nTest 6: Prefer: resolution=ignore-duplicates keeps existing row, no error');
  const before6 = await admin.query('SELECT count FROM upsert_test WHERE sku=$1', ['A']);
  r = await rest('POST', 'upsert_test?on_conflict=sku', {
    body: { sku: 'A', name: 'should-not-overwrite', count: 99999 },
    prefer: 'resolution=ignore-duplicates',
  });
  ok('ignore-duplicates returns 201', r.status === 201, JSON.stringify(r.body));
  const after6 = await admin.query('SELECT count, name FROM upsert_test WHERE sku=$1', ['A']);
  ok('existing count preserved', after6.rows[0].count === before6.rows[0].count);
  ok('existing name preserved', after6.rows[0].name !== 'should-not-overwrite');

  // ── Test 7: Bulk upsert of multiple rows in one request ─────────
  console.log('\nTest 7: bulk upsert (array body) updates some, inserts others');
  r = await rest('POST', 'upsert_test?on_conflict=sku', {
    body: [
      { sku: 'A', name: 'alpha', count: 1 },
      { sku: 'B', name: 'bravo', count: 2 },
      { sku: 'C', name: 'charlie', count: 3 },
    ],
  });
  ok('bulk upsert returns 201', r.status === 201, JSON.stringify(r.body));
  const total = await admin.query('SELECT count(*)::int AS n FROM upsert_test');
  ok('all three rows present', total.rows[0].n === 3, `got ${total.rows[0].n}`);

  // ── Cleanup ─────────────────────────────────────────────────────
  await admin.query('DROP TABLE upsert_test');
  await admin.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Test harness crashed:', e); process.exit(2); });
