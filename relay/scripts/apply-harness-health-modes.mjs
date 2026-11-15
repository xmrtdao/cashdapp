#!/usr/bin/env node
/**
 * apply-harness-health-modes.mjs
 *
 * Applies relay/migrations/harnesses_002_health_modes.sql to the local
 * Postgres that backs app.harnesses (the same database the relay's
 * queryLocalPg uses).
 *
 * Idempotent: the migration itself is written with IF NOT EXISTS and
 * ON CONFLICT-style updates, so running it twice is a no-op.
 *
 * Usage:
 *   node relay/scripts/apply-harness-health-modes.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '..');
const ROOT = join(RELAY, '..');
const SQL_FILE = join(RELAY, 'migrations', 'harnesses_002_health_modes.sql');

// Same connection string the relay uses.
const CONNECTION = process.env.LOCAL_PG_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

function readEnvValue(file, name) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      if (t.slice(0, i).trim() === name) return t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no env file */ }
  return null;
}

const fromEnv = readEnvValue(join(RELAY, '.env'), 'LOCAL_PG_URL')
  || readEnvValue(join(RELAY, '.env'), 'DATABASE_URL');
const connectionString = fromEnv || CONNECTION;

const client = new Client({ connectionString });
try {
  await client.connect();
  const sql = readFileSync(SQL_FILE, 'utf8');
  await client.query(sql);
  console.log(`[apply-harness-health-modes] applied ${SQL_FILE}`);

  const r = await client.query(
    `SELECT id, type, endpoint, health_mode, health_path, ui_endpoint, supervised, status
     FROM app.harnesses ORDER BY id`
  );
  console.table(r.rows.map(h => ({
    id: h.id,
    mode: h.health_mode,
    endpoint: h.endpoint || '-',
    ui: h.ui_endpoint || '-',
    supervised: h.supervised ? 'yes' : 'no',
    status: h.status,
  })));
} catch (e) {
  console.error('[apply-harness-health-modes] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { await client.end(); } catch {}
}
