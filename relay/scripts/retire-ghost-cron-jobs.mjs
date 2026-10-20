/**
 * relay/scripts/retire-ghost-cron-jobs.mjs
 *
 * The cron table schedules three commands that can never succeed, because they
 * call SQL functions that were never written:
 *
 *   SELECT app.run_agent_work_executor(5);     (cron.job 42 + cron-jobs.json 178)
 *   SELECT app.run_github_issue_scanner();     (cron.job 22, 43 + json 179)
 *
 * The real executor is `node relay/scripts/agent-work-executor-tick.mjs`
 * (cron.job 21), which runs against the local edge function and works. The two
 * SQL rows are duplicates that fail twice per tick and make the fleet believe
 * the executor is missing. It is not: the caller is wrong, and the function it
 * calls does not exist and is not needed.
 *
 * This removes the dead callers rather than inventing the function. If a real
 * GitHub scanner is wanted later, implement it and schedule that - do not
 * resurrect a SQL call to nobody's function.
 *
 * It also repoints the cuttlefish jobs at app.registry_agents, the table that
 * exists (app.cuttlefish_agents was never there; public.cuttlefish_agents and
 * public.registry_agents are views).
 *
 *   node relay/scripts/retire-ghost-cron-jobs.mjs --apply
 */

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL,
});
const q = (s, p) => pool.query(s, p);

const GHOST_COMMANDS = [
  'SELECT app.run_agent_work_executor(5);',
  'SELECT app.run_github_issue_scanner();',
];

let exitCode = 0;
try {
  const before = await q(
    `SELECT id, name, enabled, command FROM cron.job
      WHERE command = ANY($1::text[]) OR command LIKE '%app.cuttlefish_agents%'
      ORDER BY id`, [GHOST_COMMANDS]);
  console.log('=== before ===');
  for (const r of before.rows) console.log(`  id=${r.id} enabled=${r.enabled} ${r.name} :: ${r.command.slice(0, 90)}`);

  if (APPLY) {
    const del = await q('DELETE FROM cron.job WHERE command = ANY($1::text[]) RETURNING id', [GHOST_COMMANDS]);
    console.log(`\nremoved ${del.rowCount} ghost row(s): ${del.rows.map((r) => r.id).join(', ') || 'none'}`);

    const upd = await q(
      `UPDATE cron.job SET command = replace(command, 'app.cuttlefish_agents', 'app.registry_agents')
        WHERE command LIKE '%app.cuttlefish_agents%' RETURNING id`);
    console.log(`repointed ${upd.rowCount} cuttlefish row(s): ${upd.rows.map((r) => r.id).join(', ') || 'none'}`);
  } else {
    console.log('\nplan only - pass --apply');
  }

  // ── verify ────────────────────────────────────────────────────────────────
  const ghosts = await q('SELECT id FROM cron.job WHERE command = ANY($1::text[])', [GHOST_COMMANDS]);
  const cuttle = await q(`SELECT id FROM cron.job WHERE command LIKE '%app.cuttlefish_agents%'`);

  // Every enabled SQL job that calls app.<fn>(...) must name a function that exists.
  const enabled = await q(`SELECT id, name, command FROM cron.job WHERE enabled IS NOT FALSE AND command ~* '^\\s*SELECT\\s+app\\.'`);
  const missing = [];
  for (const r of enabled.rows) {
    const m = r.command.match(/app\.([a-z0-9_]+)\s*\(/i);
    if (!m) continue;
    const ex = await q(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                         WHERE n.nspname='app' AND p.proname=$1`, [m[1]]);
    if (!ex.rowCount) missing.push(`cron.job ${r.id} (${r.name}) calls missing app.${m[1]}()`);
  }

  console.log('\n=== after ===');
  console.log('  ghost rows remaining: ' + ghosts.rowCount);
  console.log('  rows still pointing at app.cuttlefish_agents: ' + cuttle.rowCount);
  console.log('  enabled SQL jobs calling a missing function: ' + missing.length);
  for (const m of missing) console.log('    - ' + m);

  if (ghosts.rowCount || cuttle.rowCount || missing.length) {
    console.error('\nFAILED: dead callers remain');
    exitCode = 1;
  } else if (APPLY) {
    console.log('\nclean: no cron job calls a function that does not exist');
  }
} catch (e) {
  console.error('FAIL: ' + e.message);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
