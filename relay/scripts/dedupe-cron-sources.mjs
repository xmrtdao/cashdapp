#!/usr/bin/env node
/**
 * dedupe-cron-sources.mjs
 *
 * The runner (relay/cron-engine-v2.mjs:232) loads cron.job from the database AND
 * relay-data/cron-jobs.json, then merges them **by id**. The two files use
 * different id ranges for the same logical job, so a job that appears in both
 * runs twice per scheduled minute. This script removes that duplication:
 *
 *   1. cron.job: delete the disabled mirror rows (an "off" copy of an "on" row
 *      with the identical command) and the one doubly-enabled pair, keeping one
 *      enabled row per logical job.
 *   2. cron-jobs.json: disable JSON entries whose SQL and schedule already exist
 *      as a surviving enabled cron.job row, so the DB copy is the sole execution.
 *   3. cron-jobs.json: delete the entries that were already disabled duplicates
 *      of another JSON entry (170, 197, 168, 182).
 *   4. cron-jobs.json: delete the `SELECT 1` placeholder entries whose id is
 *      shadowed by cron.job (ids 1-7, 12). They are never loaded (the merge
 *      drops ids that already exist in the table) and they misdescribe the job:
 *      e.g. JSON id 1 says `sync-hermes-memory` runs `SELECT 1`.
 *
 * Dry-run by default. `--apply` performs the changes and writes an immutable
 * record of the deleted cron.job rows to relay-data/cron-job-removed.json.
 */
import pg from 'pg';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_PATH = join(ROOT, 'relay-data', 'cron-jobs.json');
const REMOVED_PATH = join(ROOT, 'relay-data', 'cron-job-removed.json');
const APPLY = process.argv.includes('--apply');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
});

const dbRows = (await pool.query(
  'SELECT id, name, schedule, command, enabled FROM cron.job ORDER BY id'
)).rows;
const jobs = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

// ── 1. cron.job: keep one row per logical job ─────────────────────────────
const groups = new Map();
for (const r of dbRows) {
  if (!groups.has(r.name)) groups.set(r.name, []);
  groups.get(r.name).push(r);
}

const dbDelete = [];
const dbSkipped = [];
for (const [name, rows] of groups) {
  if (rows.length < 2) continue;
  const commands = new Set(rows.map((r) => norm(r.command)));
  if (commands.size !== 1) {
    dbSkipped.push({ name, reason: 'same name, different commands', ids: rows.map((r) => r.id) });
    continue;
  }
  const keep = rows.find((r) => r.enabled) || rows[0];
  for (const r of rows) if (r.id !== keep.id) dbDelete.push(r);
}

const deletingIds = new Set(dbDelete.map((r) => r.id));
const surviving = dbRows.filter((r) => !deletingIds.has(r.id));
const enabledBySig = new Map();
for (const r of surviving) {
  if (!r.enabled) continue;
  const key = norm(r.command) + '||' + r.schedule;
  enabledBySig.set(key, r);
}

// ── 2/3/4. cron-jobs.json ─────────────────────────────────────────────────
const jsonDisable = [];
const jsonDelete = [];
const PLACEHOLDER_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 12]);
const KNOWN_DUPLICATES = new Set([170, 197, 168, 182]);

for (const j of jobs) {
  if (KNOWN_DUPLICATES.has(j.id)) { jsonDelete.push({ j, why: 'disabled duplicate of another JSON entry' }); continue; }
  if (j.type === 'sql' && PLACEHOLDER_IDS.has(j.id) && norm(j.sql) === 'select 1') {
    jsonDelete.push({ j, why: 'SELECT 1 placeholder, id shadowed by cron.job, never loaded' });
    continue;
  }
  if (j.disabled) continue;
  if (j.type !== 'sql' || !j.sql) continue;
  const key = norm(j.sql) + '||' + j.schedule;
  const match = enabledBySig.get(key);
  if (match) jsonDisable.push({ j, db: match });
}

// ── report ────────────────────────────────────────────────────────────────
console.log('cron.job rows before      :', dbRows.length);
console.log('cron.job to delete        :', dbDelete.length);
for (const r of dbDelete) console.log(`   DEL [${r.id}] ${r.name} (${r.enabled ? 'enabled' : 'disabled'} mirror)`);
for (const s of dbSkipped) console.log(`   SKIP ${s.name}: ${s.reason} ids=${s.ids.join(',')}`);

console.log('\ncron-jobs.json entries    :', jobs.length);
console.log('json to disable           :', jsonDisable.length, '(DB copy is authoritative)');
for (const { j, db } of jsonDisable) console.log(`   OFF [${j.id}] ${j.name}  -> cron.job[${db.id}]`);
console.log('json to delete            :', jsonDelete.length);
for (const { j, why } of jsonDelete) console.log(`   DEL [${j.id}] ${j.name}  (${why})`);

if (dbSkipped.length) {
  console.log('\nREFUSING TO APPLY: same-name groups with different commands need a human decision.');
  process.exitCode = 2;
}
if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to make these changes.');
  await pool.end();
  process.exit(process.exitCode || 0);
}

// ── apply ─────────────────────────────────────────────────────────────────
const removed = dbDelete.map((r) => ({ ...r, removed_at: new Date().toISOString(), reason: 'duplicate cron source row' }));
const prior = existsSync(REMOVED_PATH) ? JSON.parse(readFileSync(REMOVED_PATH, 'utf8')) : [];
writeFileSync(REMOVED_PATH, JSON.stringify(prior.concat(removed), null, 2) + '\n', 'utf8');

const client = await pool.connect();
try {
  await client.query('BEGIN');
  if (dbDelete.length) {
    await client.query('DELETE FROM cron.job WHERE id = ANY($1::int[])', [dbDelete.map((r) => r.id)]);
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}

const delIds = new Set(jsonDelete.map((x) => x.j.id));
const offIds = new Map(jsonDisable.map((x) => [x.j.id, x.db.id]));
const out = jobs
  .filter((j) => !delIds.has(j.id))
  .map((j) => (offIds.has(j.id)
    ? { ...j, disabled: true, note: `${j.note ? j.note + ' ' : ''}[duplicate of cron.job ${offIds.get(j.id)}; disabled so it runs once]` }
    : j));
writeFileSync(JSON_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`\napplied: ${dbDelete.length} cron.job row(s) deleted, ${jsonDisable.length} JSON entry(s) disabled, ${jsonDelete.length} JSON entry(s) deleted.`);
console.log(`cron.job rows after       : ${dbRows.length - dbDelete.length}`);
console.log(`cron-jobs.json after      : ${out.length}`);
await pool.end();
