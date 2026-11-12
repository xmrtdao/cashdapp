#!/usr/bin/env node
/**
 * relay/cron-engine-v2.mjs — Local cron job executor
 *
 * Replaces cron-engine.mjs (which used `psql -U postgres` and
 * `cmd.exe` spawns that hung waiting for a password). The old
 * engine referenced a non-existent `pg/bin/` path; this v2
 * connects to the embedded PG via the `pg` npm client using
 * the same connection string as the rest of the system:
 *
 *   postgres://postgres:postgres@localhost:5432/postgres
 *
 * It also uses the local edge function runtime at port 8090
 * (suite/runtime/manager.mjs) for "edge function" cron jobs
 * instead of proxying to the dead Supabase.
 *
 * Run with --once to execute due jobs once and exit, or as a
 * daemon that polls every 30s.
 */

import pg from 'pg';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
const { Client, Pool } = pg;
// Use the shared connection pool from relay/lib/db.mjs to prevent
// "too many clients" — was creating a separate pool here (max 5) that
// competed with server.js's pool (max 5) and localDb.mjs's pool (max 5).
// Consolidated July 17, 2026.
import { getPool as getSharedPool, query as dbQuery } from './lib/db.mjs';
// NOTE: Do NOT capture the pool at import time — getSharedPool() returns
// the current _pool reference, but the health check in db.mjs may replace
// it (calling oldPool.end()) after 3 consecutive failures. Always call
// getSharedPool() right before use to get the live pool reference.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'relay-data');
const LOG_FILE = join(DATA_DIR, 'cron-engine-v2.log');
const STATE_FILE = join(DATA_DIR, 'cron-engine-v2-state.json');
mkdirSync(DATA_DIR, { recursive: true });

// Prefer LOCAL_DATABASE_URL (the convention used in relay/.env) over
// DATABASE_URL. The default fallback pointed at the empty `postgres`
// database, which caused every cron tick to log
// "relation/function/schema does not exist" even when the objects
// existed in xmrt_suite. Accept either env var to avoid breaking
// environments that only set DATABASE_URL.
// NOTE: PG_URL is no longer used directly — the shared pool from
// relay/lib/db.mjs handles connection config. Kept for reference.
const PG_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://postgres@127.0.0.1:5432/xmrt_suite';

// 2026-06-10: Default to local-sb (54321) instead of suite/runtime/manager.mjs
// (8090). The 8090 runtime is not running in the current local stack; local-sb
// on 54321 is the actual edge function host. Override with LOCAL_RUNTIME_URL
// env var if the suite runtime comes back.
const RUNTIME_URL = process.env.LOCAL_RUNTIME_URL || 'http://127.0.0.1:54321';

// How long to wait before the one retry a connectivity failure gets.
//
// Long enough to cover the relay coming back, short enough not to hold the
// tick hostage: the tick runs jobs one after another, so a long wait here is a
// long wait for every job behind this one.
const TRANSIENT_RETRY_DELAY_MS = 8_000;

// The relay's own API key, for the calls this engine makes back into the
// relay (the python-exec tool below). It was a literal in this file, which put
// a live credential in every copy of the source and in git history.
//
// The environment already carries it: the supervisor starts this process with
// relay/.env loaded, so the key is read from there rather than written down
// here.
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';

// ── Log rotation ────────────────────────────────────────────
//
// The log was 125MB of append-only text and still growing: the daemon writes
// about forty lines every thirty seconds, forever, with nothing ever removing
// them. "Review cron-engine-v2 logs" is the instruction half the fleet keeps
// receiving, and a 125MB file is not a file anybody reviews - it is a file
// people grep once and give up on.
//
// Three generations are kept. The oldest is dropped, so the disk cost is
// bounded at roughly four times the threshold however long the daemon runs.
const LOG_MAX_BYTES = 20 * 1024 * 1024;
const LOG_GENERATIONS = 3;

function rotateLogIfNeeded() {
  try {
    const st = statSync(LOG_FILE);
    if (!st || st.size < LOG_MAX_BYTES) return;
    for (let i = LOG_GENERATIONS; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      if (!existsSync(from)) continue;
      if (i === LOG_GENERATIONS) {
        try { unlinkSync(from); } catch {}
      } else {
        try { renameSync(from, `${LOG_FILE}.${i + 1}`); } catch {}
      }
    }
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // No log file yet, or the filesystem said no. Rotation is housekeeping;
    // failing to rotate must never stop the daemon from running a job.
  }
}

function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { rotateLogIfNeeded(); } catch {}
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

// ── Cron scheduling ───────────────────────────────────────────────────────
//
// A job is due when its schedule matched ANY minute since it last ran - not
// only when it matches the minute the engine happens to look at it.
//
// This distinction is the difference between a scheduler and a coin toss.
//
// The engine walks the job list in order, and that list is the 37 cron.job
// rows first, then the jobs from cron-jobs.json. By the time it reaches the
// later entries the tick is 30-100 seconds old (the tick runs jobs SERIALLY,
// and several of them take 30-60 seconds), so the wall-clock minute has
// MOVED PAST the minute those jobs are scheduled for. Asking such a job
// only "does your schedule match right now?" skips it forever: the minute
// it is evaluated in is never one of its own.
//
// That is not a hypothesis - it is what the estate measured.
//
//   learning-cycle, system-status, code-monitor-daemon, cron-proxy,
//   fleet-chat-heartbeat, opportunity-scanner-fast, api-key-health-monitor,
//   video-job-processor and the daily/weekly posts: ZERO executions since
//   Oct 21, while every cron.job row ran at 94-100% of its schedule.
//
// Their silence read as "not scheduled", and the repair that followed (the
// Oct 19 incident recorded in PIPELINE_PLAN.md) never touched them, because
// they were not failing. They were simply never reached at the right minute.
//
// Catch-up semantics fixes both halves of the problem: a slot that passed
// while the engine was busy, behind a 60-second edge call, or during a
// restart runs exactly once when the engine next looks - never zero times,
// and never twice.

const CRON_MAX_CATCHUP_DAYS = 400;

function cronFieldMatches(field, value) {
  if (field === '*') return true;
  if (field.startsWith('*/')) return value % parseInt(field.slice(2), 10) === 0;
  if (field.includes(',')) return field.split(',').map(Number).includes(value);
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

function cronFieldValues(field, lo, hi) {
  const out = [];
  for (let v = lo; v <= hi; v++) if (cronFieldMatches(field, v)) out.push(v);
  return out;
}

/**
 * Is `expr` due between sinceMs and nowMs?
 *
 * Walks the DAYS in the window (never every minute of it), and for each day
 * that satisfies the day-of-month/month/day-of-week fields, checks the
 * candidate hour/minute pairs against the window.
 */
function cronDueSince(expr, sinceMs, nowMs) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return { error: `Invalid cron: ${expr}` };
  const minutes = cronFieldValues(parts[0], 0, 59);
  const hours = cronFieldValues(parts[1], 0, 23);
  if (!minutes.length || !hours.length) return { error: `Invalid cron: ${expr}` };
  const now = new Date(nowMs);
  const earliest = new Date(Math.max(sinceMs, nowMs - CRON_MAX_CATCHUP_DAYS * 86400000));
  const day = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate());
  const lastDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (day <= lastDay) {
    if (cronFieldMatches(parts[2], day.getDate())
      && cronFieldMatches(parts[3], day.getMonth() + 1)
      && cronFieldMatches(parts[4], day.getDay())) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
          // Strictly after the last run: the slot the job already served
          // (and only that slot) must not be served twice.
          if (t.getTime() > sinceMs && t.getTime() <= nowMs) return { due: true };
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return { due: false };
}

// ── DB Activity Logger ──────────────────────────────────
// Logs to the relay's activity feed table so the Ships Log
// shows cron executions and edge function calls.
async function logToDb(activityType, title, status, description, metadata = {}, agentId = null) {
  try {
    const pool = getSharedPool();
    await pool.query(
      `INSERT INTO public.eliza_activity_log (activity_type, title, description, status, agent_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [activityType, title || activityType, description || '', status || 'info', agentId || 'cron', JSON.stringify(metadata)]
    );
  } catch (e) {
    // Silently fail — logging is best-effort
  }
}

// ── Cron Execution Write Path ──────────────────────────
// Writes a cron job execution to the dedicated tracking tables:
//   - public.cron_execution_log  (audit trail, one row per run)
//   - public.edge_function_logs (only for edge-function jobs)
//   - public.cron_registry       (run_count / last_run_at / last_status)
// plus the existing eliza_activity_log feed. This closes the
// "write path gap" where cron jobs ran but nothing recorded them
// in the dedicated log tables (they were stuck at 0 rows).

/**
 * The one sentence that says why a job failed.
 *
 * WHY THIS EXISTS
 * ---------------
 *
 * A shell job that exits non-zero used to produce `FAIL: undefined` in the log
 * and an EMPTY `error` column in cron_execution_log. The reason was in the
 * child's stderr, which the runner captured and then threw away, because the
 * failure branch of runShellCommand() returned `ok:false` and nothing else.
 *
 * That is not a cosmetic problem. It is the reason this task exists.
 *
 * The fleet reads cron_execution_log and posts the failures to the fleet board
 * every thirty minutes; a shell failure arrived there as "relay-health-check
 * failed 7x - no detail". The log said `FAIL: undefined`. The dashboard panel
 * said `cron relay-health-check failed`. Nothing anywhere said WHY. Every
 * agent that read any of those surfaces was told to go and investigate cron job
 * errors with no error to investigate - and the fleet-chat task creator
 * dutifully filed "Investigate cron job errors" again and again, from its own
 * announcements, because the announcements mentioned cron and failure and
 * nothing else.
 *
 * So: every failure gets a reason, in every place the failure is written.
 * A failure with no recorded reason is a failure nobody can fix.
 */
export function jobErrorText(res) {
  if (!res || res.ok) return '';
  const parts = [];
  const raw = String(res.error || '').trim();
  if (raw) parts.push(raw);
  if (!parts.length && res.stderr) {
    const err = String(res.stderr).trim();
    if (err) parts.push(err);
  }
  if (!parts.length && res.exitCode !== undefined && res.exitCode !== null) {
    parts.push(`exit ${res.exitCode}`);
  }
  if (!parts.length) parts.push('failed with no reason reported by the job');
  return parts.join(' | ').slice(0, 2000);
}

/**
 * Write the audit row for one cron run, and do not lose it to a busy database.
 *
 * The shared pool gives every connection `statement_timeout = 10s`
 * (relay/lib/db.mjs). Under load - and the database IS under load here, this
 * runs once per job per tick - the insert can exceed that and be cancelled.
 * When that happened the run simply vanished: no row, no error, and the
 * operator's only evidence that anything went wrong was a WARN line in a log
 * file nobody reads.
 *
 * So the write is retried once, and the failure is announced loudly if it
 * still fails. The audit trail is the record; a record that drops itself under
 * load is not a record.
 */
async function writeCronExecutionRow(pool, { job, jobName, fnName, platform, status, startedAt, finishedAt, durationMs, res, errorText }) {
  const params = [
    jobName,
    fnName,
    platform,
    status,
    startedAt ? startedAt.toISOString() : null,
    finishedAt.toISOString(),
    durationMs,
    JSON.stringify({ jobId: job.id, type: job.type }),
    res.ok ? JSON.stringify({ rows: res.rows ?? null, status: res.status ?? null }) : null,
    res.ok ? null : errorText,
    1,
    'cron',
  ];
  const sql = `INSERT INTO public.cron_execution_log
         (job_name, function_name, platform, status, started_at, finished_at, duration_ms, payload, result, error, run_count, owner_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await pool.query(sql, params);
      return true;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        log(`logCronExecution: cron_execution_log write failed (${e.message}); retrying`, 'WARN');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  log(`logCronExecution: cron_execution_log write failed: ${lastErr?.message} — the run of "${jobName}" is NOT in the audit trail`, 'ERROR');
  return false;
}

async function logCronExecution(job, res, startedAt) {
  const finishedAt = new Date();
  const durationMs = startedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null;
  const jobName = job.name || job.fn || `job-${job.id}`;
  const fnName = job.fn || (job.command && job.command.match(/functions\/v1\/([a-zA-Z0-9_-]+)/)?.[1]) || job.command || null;
  const status = res.ok ? 'completed' : 'failed';
  const platform = job.type === 'edge' ? 'edge' : 'local';
  const pool = getSharedPool();
  const errorText = jobErrorText(res);

  // 1. cron_execution_log — one row per run
  //
  // The write is retried. It failed on 2026-10-22 with "canceling statement
  // due to statement timeout" - the shared pool sets statement_timeout to
  // 10s on every connection (relay/lib/db.mjs), and a busy database can miss
  // that. When it fails, the run is not in the audit trail AT ALL: the row is
  // the only record that the job ran and failed, and a failure that leaves no
  // trace is a failure the operator is told about by nobody.
  await writeCronExecutionRow(pool, {
    job, jobName, fnName, platform, status, startedAt, finishedAt, durationMs, res, errorText,
  });

  // 2. edge_function_logs — only for edge-function jobs
  if (job.type === 'edge' && fnName) {
    try {
      await pool.query(
        `INSERT INTO public.edge_function_logs
           (function_name, event_type, event_message, level, timestamp, execution_time_ms, status_code, metadata, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          fnName,
          'cron_execution',
          res.ok ? `Cron job ${jobName} completed` : `Cron job ${jobName} failed: ${errorText.slice(0, 200)}`,
          res.ok ? 'info' : 'error',
          finishedAt.toISOString(),
          durationMs,
          res.status ?? (res.ok ? 200 : 500),
          JSON.stringify({ jobId: job.id, type: job.type }),
          status,
        ]
      );
    } catch (e) {
      log(`logCronExecution: edge_function_logs write failed: ${e.message}`, 'WARN');
    }
  }

  // 3. cron_registry — increment run_count, set last_run_at / last_status
  try {
    await pool.query(
      `UPDATE public.cron_registry
         SET run_count = COALESCE(run_count, 0) + 1,
             last_run_at = NOW(),
             last_status = $2,
             updated_at = NOW()
       WHERE job_name = $1`,
      [jobName, status]
    );
  } catch (e) {
    log(`logCronExecution: cron_registry update failed: ${e.message}`, 'WARN');
  }

  // 4. eliza_activity_log — keep the existing feed (Ships Log)
  await logToDb(
    job.type === 'sql' ? 'cron_execution' : 'edge_function',
    jobName,
    status,
    res.ok
      ? `${job.type}: ${jobName}`
      : `Error: ${errorText.slice(0, 200)}`,
    { jobId: job.id, rows: res.rows, status: res.status, error: res.ok ? null : errorText },
    'cron'
  );
}

/**
 * Is this command shell code rather than SQL?
 *
 * The trailing \s is load-bearing: it means "this token, followed by
 * whitespace", so a shell word that merely starts with one of these names
 * cannot be captured by accident.
 *
 * `py` was missing, and on Windows `py` is the launcher - `py
 * relay/cron-python/arch-ecosystem-scanner.py` is how that job is written. It
 * did not match, so it fell through to type 'sql' and was handed to Postgres,
 * which replied `syntax error at or near "py"`. arch-ecosystem-scanner failed
 * every 6 hours, 449 times in cron_execution_log, and the only evidence was a
 * Postgres error that says nothing about the real cause. A misclassification
 * that reports itself as a database problem is worse than no classification.
 *
 * Audited against all 85 commands in cron.job plus cron-jobs.json: the first
 * tokens actually present are SELECT, UPDATE, DELETE, node, cd, python and py.
 * All seven classify correctly under this pattern and none is captured by
 * accident. If a new interpreter appears, add it here AND the audit in
 * tests/cron-classify.test.mjs will fail until you do.
 */
const SHELL_COMMAND_RE = /^(?:python3?|py|node|cd|bash|sh|pwsh|powershell)\s/i;

/** Classify a cron.job command into the three kinds the runner understands. */
export function classifyCommand(cmd) {
  const c = String(cmd || '').trim();
  if (/^SELECT\s+extensions\.http/i.test(c)) return 'edge';
  if (SHELL_COMMAND_RE.test(c)) return 'shell';
  return 'sql';
}

export async function loadJobsFromPg() {
  let c = null;
  try {
    c = await getSharedPool().connect();
  } catch (e) {
    // THE DATABASE IS NOT THERE. THAT IS NOT A REASON TO DO NOTHING.
    //
    // connect() sits OUTSIDE the try/catch below, so a database that was down
    // (or restarting) threw out of this function, out of tick(), and the whole
    // tick was abandoned. Every job that was due in that minute - a health
    // check, a heartbeat, a task escalation - did not run, and did not even
    // log. The daemon said "tick error: connect ECONNREFUSED 127.0.0.1:5432"
    // and then carried on thirty seconds later, as if a minute of work had
    // been done.
    //
    // The JSON file is a complete enough source on its own - it holds 69 of
    // the 106 jobs - so the tick keeps running from it, and the jobs that
    // need the database will say so themselves.
    log(`loadJobsFromPg: database unreachable (${e.message}); running from cron-jobs.json`, 'WARN');
    return readJobsJson();
  }
  try {
    // The supabase schema has cron jobs in cron.job (pg_cron). The
    // local PG might or might not have pg_cron installed; if not,
    // we fall back to reading from a JSON file the relay maintains.
    let rows;
    try {
      const r = await c.query("SELECT id, name, schedule, command, enabled FROM cron.job ORDER BY id");
      rows = r.rows;
      // Detect type: SQL, edge function, or shell command
      rows = rows.map((j) => ({
        ...j,
        type: classifyCommand(j.command),
        name: j.name || ('job-' + j.id),
        disabled: j.enabled === false,
      }));
      // ── MERGE, do not replace ─────────────────────────────────────────
      //
      // This used to read cron-jobs.json only when cron.job was EMPTY, so the
      // moment cron.job had a single row in it, the 84 hand-maintained jobs in
      // the JSON stopped being scheduled - including 303 jobby-heartbeat, 304
      // the morning summary and 305 the evening summary. The daemon logged
      // "loaded 56 jobs" and looked perfectly healthy while the Jobby loop had
      // silently stopped running.
      //
      // A fallback that replaces is a fallback in the wrong direction. The two
      // sources are additive, so they are merged: cron.job wins on ids it has,
      // JSON-only ids are added, and both counts are logged so a shadowed job
      // cannot go unnoticed again.
      const jsonJobs = readJobsJson();
      const tableIds = new Set(rows.map((r) => Number(r.id)));
      const jsonOnly = jsonJobs.filter((j) => !tableIds.has(Number(j.id)));
      const tableOnly = rows.filter((r) => !jsonJobs.some((j) => Number(j.id) === Number(r.id)));
      // Jobs in BOTH registries are dropped from the JSON side: the table
      // wins on the id. That is the intended de-duplication, but when the
      // two entries are DIFFERENT jobs that share an id, the JSON one dies
      // without a trace - which is what happened to
      // XMRT-DAO-SeasonalScraper (json id 14), shadowed by the table's
      // id 14 "memory-watchdog". It had never run once, and nothing said so.
      const shadowed = jsonJobs.filter((j) => tableIds.has(Number(j.id)));

      rows = rows.concat(jsonOnly);

      if (jsonOnly.length) {
        log(`merged cron-jobs.json: +${jsonOnly.length} job(s) not in cron.job ` +
          `(ids ${jsonOnly.slice(0, 12).map(j => j.id).join(',')}${jsonOnly.length > 12 ? ',...' : ''})`);
      }
      if (tableOnly.length) {
        log(`cron.job has ${tableOnly.length} job(s) not in cron-jobs.json ` +
          `(${tableOnly.slice(0, 8).map(r => `${r.id}:${r.name}`).join(',')}${tableOnly.length > 8 ? ',...' : ''})`);
      }
      for (const j of shadowed) {
        // A disabled JSON entry that shadows a table row is a deliberate
        // de-duplication, not a lost job. Only an ENABLED entry with a
        // different name is a job that will never run.
        if (j.disabled) continue;
        const t = rows.find((r) => Number(r.id) === Number(j.id));
        if (t && String(t.name) !== String(j.name)) {
          log(`SHADOWED JOB: cron-jobs.json id ${j.id} "${j.name}" (${j.schedule}) ` +
            `is NOT scheduled - cron.job id ${j.id} "${t.name}" owns that id`, 'WARN');
        }
      }
    } catch (e) {
      // pg_cron not available; read from relay-data/cron-jobs.json
      if (!existsSync(join(DATA_DIR, 'cron-jobs.json'))) {
        log('no cron.job table and no cron-jobs.json; nothing to do', 'WARN');
        return [];
      }
      rows = readJobsJson();
    }
    return rows;
  } finally {
    c.release();
  }
}

/**
 * relay-data/cron-jobs.json, normalised to the shape the runner expects.
 *
 * The JSON keeps a job's payload under a type-specific key (`sql`, `fn`,
 * `action`); the runner wants `command` for sql, `fn`+`body` for edge, and
 * `action` for local. This mapping was inline in two places and is here once
 * now.
 */
function readJobsJson() {
  const f = join(DATA_DIR, 'cron-jobs.json');
  if (!existsSync(f)) return [];
  const parsed = JSON.parse(readFileSync(f, 'utf8'));
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || Object.values(parsed).flat());
  return jobs.map((j) => {
    const common = { id: j.id, schedule: j.schedule, name: j.name, disabled: j.disabled === true };
    if (j.type === 'sql' && j.sql) return { ...common, type: 'sql', command: expandEnv(j.sql) };
    if (j.type === 'ef' && j.fn) return { ...common, type: 'edge', fn: j.fn, body: expandEnv(j.body || {}) };
    if (j.type === 'local' && j.action) return { ...common, type: 'local', action: j.action };
    return j;
  });
}

/**
 * Expand ${VAR} and ${VAR:-default} in a string, or in the strings of an
 * object.
 *
 * WHY THIS EXISTS
 * ---------------
 *
 * relay-data/cron-jobs.json is a LIVE CONFIGURATION FILE, and it used to
 * hold the relay's own API key in plain text - because the only way to
 * give a job a key was to type the key.
 *
 * A scanner that "fixed" that by writing "${RELAY_API_KEY}" into the file
 * would have broken every job in it, because nothing expanded it: the cron
 * engine would have sent the literal string "${RELAY_API_KEY}" as the API
 * key and been refused.
 *
 * So the reader expands references FIRST, and the file can be rewritten
 * afterwards. The order matters: teach the reader, then change the file.
 *
 * A reference that names a variable that is not set is left ALONE, rather
 * than becoming an empty string. An empty key fails with a confusing
 * "unauthorized", and a literal "${RELAY_API_KEY}" fails with an
 * obviously wrong value, which is much easier to read.
 */
function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name, fallback) => {
      const found = process.env[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      return match;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

async function runSql(sql) {
  const c = await getSharedPool().connect();
  try {
    const r = await c.query(sql);
    return { ok: true, rows: r.rowCount };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    c.release();
  }
}

// ── Fleet Chat Heartbeat ──────────────────────────────────
async function runFleetChatHeartbeat() {
  // DISABLED: was causing recursive notification loops (system posts → agents
  // comment → system posts about comments → agents comment again). The fleet
  // chat is now driven by genuine agent activity, not automated prompts.
  console.log('[fleet-chat-heartbeat] DISABLED — recursive notification loop prevention');
  return { ok: true, result: 'disabled: recursive loop prevention' };
  try {
    const msgsRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=10', { signal: AbortSignal.timeout(5000) });
    const msgsData = await msgsRes.json().catch(() => ({ messages: [] }));
    const recentMsgs = (msgsData.messages || []).slice(-5);
    const statusRes = await fetch('http://127.0.0.1:8080/api/supervisor/status', { signal: AbortSignal.timeout(5000) });
    const statusData = await statusRes.json().catch(() => ({}));
    const services = (statusData.services || []).filter(s => s.healthy);
    const tokenRes = await fetch('http://127.0.0.1:8080/api/token-usage/summary/agents?days=1', { signal: AbortSignal.timeout(5000) });
    const tokenData = await tokenRes.json().catch(() => []);
    const totalTokens = tokenData.reduce((s, t) => s + (parseInt(t.total_tokens) || 0), 0);
    const lastMsg = recentMsgs[recentMsgs.length - 1];
    const timeSinceLastMsg = lastMsg ? Math.floor((Date.now() - (lastMsg.ts || 0)) / 60000) : 999;
    const agents = ['vex', 'eliza', 'alice', 'trib', 'arch', 'hermes'];
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    let prompt;
    if (timeSinceLastMsg > 60) {
      const topics = [
        `@${agent} the fleet has been quiet for a while. What is on your mind? Any observations about the system?`,
        `@${agent} it has been a quiet ${timeOfDay} on the fleet. Anything you want to flag or discuss?`,
        `@${agent} the ${timeOfDay} watch is quiet. How are things looking from your station?`,
      ];
      prompt = topics[Math.floor(Math.random() * topics.length)];
    } else if (totalTokens > 0) {
      const lastTopic = lastMsg ? lastMsg.message.slice(0, 80) : 'system operations';
      const prompts = [
        `@${agent} I noticed recent activity about "${lastTopic}". Do you have any thoughts to add?`,
        `@${agent} we have used ${totalTokens.toLocaleString()} tokens in the last 24h. How is your workload looking?`,
        `@${agent} ${services.length} services are healthy. Anything you want to check in on?`,
      ];
      prompt = prompts[Math.floor(Math.random() * prompts.length)];
    } else {
      const prompts = [
        `@${agent} status check — how are things on your end?`,
        `@${agent} anything to report this ${timeOfDay}?`,
        `@${agent} ${timeOfDay} check-in. All quiet?`,
      ];
      prompt = prompts[Math.floor(Math.random() * prompts.length)];
    }
    const sendRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'system', message: prompt, channel: 'fleet' }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: sendRes.ok, result: `Fleet heartbeat sent to @${agent}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Fleet Chat Follow-Up ──────────────────────────────────
async function runFleetChatFollowUp() {
  // DISABLED: was causing recursive notification loops.
  console.log('[fleet-chat-followup] DISABLED — recursive notification loop prevention');
  return { ok: true, result: 'disabled: recursive loop prevention' };
  try {
    const msgsRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=10', { signal: AbortSignal.timeout(5000) });
    const msgsData = await msgsRes.json().catch(() => ({ messages: [] }));
    const msgs = (msgsData.messages || []).slice(-10);
    let lastSystemPrompt = null;
    let lastSystemPromptIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].agent === 'system' && msgs[i].message.startsWith('@')) {
        lastSystemPrompt = msgs[i];
        lastSystemPromptIdx = i;
        break;
      }
    }
    if (!lastSystemPrompt) return { ok: true, result: 'No system prompt found' };
    const mentionMatch = lastSystemPrompt.message.match(/^@(\w+)/);
    if (!mentionMatch) return { ok: true, result: 'No @mention in system prompt' };
    const promptedAgent = mentionMatch[1].toLowerCase();
    // Skip prompts older than 10 minutes to avoid re-prompting stale threads
    const promptAge = Date.now() - new Date(lastSystemPrompt.ts || lastSystemPrompt.time || 0).getTime();
    if (promptAge > 600000) return { ok: true, result: `System prompt to @${promptedAgent} is stale (${Math.round(promptAge/60000)}m old), skipping` };
    // Hard cooldown: skip if we already followed up on this prompt in the last 10 minutes
    const promptId = lastSystemPrompt.id || lastSystemPrompt.ts || lastSystemPrompt.time;
    if (promptId) {
      // `state` is not defined in this module - the daemon keeps cooldowns in
      // the state file via loadState(). The old line threw a ReferenceError on
      // every follow-up check (232 failures in 24h).
      const cooldowns = loadState().followUpCooldowns || {};
      const lastFollowUp = cooldowns[promptId];
      if (lastFollowUp && (Date.now() - lastFollowUp) < 600000) {
        return { ok: true, result: `Follow-up for prompt ${promptId.slice(0,12)} already sent <10min ago, skipping` };
      }
    }
    const promptedAgentResponses = msgs.slice(lastSystemPromptIdx + 1).filter(
      m => m.agent.toLowerCase().includes(promptedAgent) && m.agent !== 'system'
    );
    if (promptedAgentResponses.length === 0) return { ok: true, result: `${promptedAgent} has not responded yet` };
    const lastResponse = promptedAgentResponses[promptedAgentResponses.length - 1];
    const followUps = msgs.slice(msgs.indexOf(lastResponse) + 1).filter(
      m => m.agent !== 'system' && !m.agent.toLowerCase().includes(promptedAgent)
    );
    if (followUps.length > 0) return { ok: true, result: 'Follow-up already happened' };
    const agents = ['vex', 'eliza', 'alice', 'trib', 'arch', 'hermes'];
    const otherAgents = agents.filter(a => a !== promptedAgent);
    const followUpAgent = otherAgents[Math.floor(Math.random() * otherAgents.length)];
    const responseSnippet = (lastResponse.message || '').slice(0, 120);
    const followUpPrompts = [
      `@${followUpAgent} ${promptedAgent} just said: "${responseSnippet}". What do you think?`,
      `@${followUpAgent} ${promptedAgent} reported in. Any thoughts on what they mentioned?`,
      `@${followUpAgent} ${promptedAgent} shared some observations. Do you have anything to add?`,
    ];
    const prompt = followUpPrompts[Math.floor(Math.random() * followUpPrompts.length)];
    const sendRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'system', message: prompt, channel: 'fleet' }),
      signal: AbortSignal.timeout(5000),
    });
    // Record cooldown
    if (promptId) {
      const s = loadState();
      if (!s.followUpCooldowns) s.followUpCooldowns = {};
      s.followUpCooldowns[promptId] = Date.now();
      saveState(s);
    }
    return { ok: sendRes.ok, result: `Follow-up sent to @${followUpAgent} about ${promptedAgent}'s response` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Fleet Chat Task Creator ──────────────────────────────
async function runFleetChatTaskCreator() {
  try {
    const msgsRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=20', { signal: AbortSignal.timeout(5000) });
    const msgsData = await msgsRes.json().catch(() => ({ messages: [] }));
    const msgs = (msgsData.messages || []).slice(-20);
    let systemIdx = -1, agentAIdx = -1, followUpIdx = -1, agentBIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.agent === 'system' && m.message.startsWith('@') && followUpIdx === -1) followUpIdx = i;
      else if (m.agent !== 'system' && agentBIdx === -1 && followUpIdx !== -1 && i < followUpIdx) agentBIdx = i;
      else if (m.agent === 'system' && m.message.startsWith('@') && agentAIdx === -1) systemIdx = i;
      else if (m.agent !== 'system' && agentAIdx === -1 && systemIdx !== -1 && i < systemIdx) agentAIdx = i;
    }
    if (systemIdx === -1 || agentAIdx === -1 || followUpIdx === -1 || agentBIdx === -1) return { ok: true, result: 'No complete conversation cycle found' };
    const agentAResponse = msgs[agentAIdx];
    const agentBResponse = msgs[agentBIdx];
    const combinedText = (agentAResponse.message + ' ' + agentBResponse.message).toLowerCase();
    let taskTitle = null, taskDescription = null, taskPriority = 3;
    // Break self-reinforcing loop: skip if this is the engine's own announcement (line 739-759 cause)
    if (combinedText.includes('Task created from fleet discussion: Investigate cron job errors')) return { ok: true, result: 'Self-reinforcing announcement skipped' };
    if (combinedText.includes('cron') && (combinedText.includes('error') || combinedText.includes('fail'))) {
      taskTitle = 'Investigate cron job errors'; taskDescription = 'Agents identified cron job issues in fleet chat. Review cron-engine-v2 logs and fix failing jobs.'; taskPriority = 1;
    } else if (combinedText.includes('service') && (combinedText.includes('down') || combinedText.includes('unreachable'))) {
      taskTitle = 'Investigate service outage'; taskDescription = 'Agents reported service issues in fleet chat. Check supervisor status and restore affected services.'; taskPriority = 1;
    } else if (combinedText.includes('knowledge') && combinedText.includes('base')) {
      taskTitle = 'Review knowledge base health'; taskDescription = 'Agents discussed knowledge base status in fleet chat. Verify entity count and fix any issues.'; taskPriority = 2;
    } else if (combinedText.includes('token') || combinedText.includes('usage')) {
      taskTitle = 'Review token usage patterns'; taskDescription = 'Agents discussed token consumption in fleet chat. Analyze usage and optimize if needed.'; taskPriority = 2;
    } else if (combinedText.includes('update') || combinedText.includes('upgrade') || combinedText.includes('deploy')) {
      taskTitle = 'Process update request from fleet discussion'; taskDescription = 'Agents discussed updates in fleet chat. Review the conversation and implement changes.'; taskPriority = 2;
    }
    if (!taskTitle) return { ok: true, result: 'No actionable topic detected' };

    // ── Dedupe, before the write ────────────────────────────────────────
    //
    // This job read the last 20 fleet-chat messages and matched keywords in
    // them. Every task it created was announced to fleet chat, and every
    // announcement said "Task created from fleet discussion: Investigate cron
    // job errors" - which contains both "cron" and "error". On the next run
    // it read its own announcement, matched the same keywords, derived the
    // same title, and filed another. Twenty-seven copies in four hours.
    //
    // The schema now refuses a duplicate open title (app.tasks
    // tasks_one_open_per_title), so the loop cannot close. The check below is
    // for the message, not for safety: the index is what actually stops it.
    // This endpoint answers with a bare array, not {tasks:[...]}.
    const already = await fetch(
      `http://127.0.0.1:8080/api/suite/tasks?status_in=PENDING,IN_PROGRESS&limit=500`,
      { signal: AbortSignal.timeout(5000) }
    ).then(r => r.json()).catch(() => null);
    const rows = Array.isArray(already) ? already : ((already && (already.tasks || already.data)) || []);
    const openTitles = new Set(
      rows
        .filter(t => !['DONE', 'CANCELLED', 'COMPLETED'].includes(String(t.status || '').toUpperCase()))
        .map(t => String(t.title || '').trim().toLowerCase())
    );
    if (openTitles.has(taskTitle.trim().toLowerCase())) {
      return { ok: true, result: `Already tracked: ${taskTitle}` };
    }

    const createRes = await fetch('http://127.0.0.1:8080/api/suite/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: taskTitle, description: taskDescription, status: 'PENDING', stage: 'DISCUSS', priority: taskPriority, category: 'fleet-chat', metadata: { source: 'fleet-chat', agent_a: agentAResponse.agent, agent_b: agentBResponse.agent, agent_a_message: agentAResponse.message.slice(0, 200), agent_b_message: agentBResponse.message.slice(0, 200) } }),
      signal: AbortSignal.timeout(5000),
    });
    if (createRes.ok) {
      await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'system', message: `📋 Task created from fleet discussion: "${taskTitle}" (priority ${taskPriority}). The task pipeline will assign it shortly.`, channel: 'fleet' }),
        signal: AbortSignal.timeout(5000),
      });
      return { ok: true, result: `Task created: ${taskTitle}` };
    }
    // 409 from the open-task-per-title index means another writer won the race.
    // That is the loop closing, not a failure.
    if (createRes.status === 409) {
      return { ok: true, result: `Already tracked (raced): ${taskTitle}` };
    }
    // A failure MUST carry its reason. This branch used to return
    // {ok, result} with no error field, and jobErrorText() - which reads
    // error / stderr / exitCode, never result - wrote the failure up as
    // "failed with no reason reported by the job" (2026-11-06 16:47:25).
    // The status code AND the response body are the reason; read both.
    const createBody = await createRes.text().catch(() => '');
    return {
      ok: false,
      error: `Failed to create task (HTTP ${createRes.status}): ${(createBody || '(empty response body)').slice(0, 200)}`,
    };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ── Jobby Heartbeat ────────────────────────────────────────
export async function runJobbyHeartbeat() {
  try {
    // Import the loop module and run one heartbeat tick
    const { createHeartbeat, defaultWorkerId } = await import('./jobby/loop.mjs');
    const pool = await import('./lib/db.mjs').then(m => m.getPool());

    const workerId = defaultWorkerId();
    const heartbeat = createHeartbeat({
      pool,
      workerId,
      intervalMs: 15 * 60 * 1000, // 15 minutes
      quietHours: { from: 22, to: 7 }, // 10pm-7am local
      log: (msg) => console.log(`[Jobby Heartbeat] ${msg}`),
      // The steps. Empty before now, which is why 543 cycles decided "source"
      // and did nothing: decide() picks a decision and then
      // `for (const name of Object.keys(steps))` iterates nothing at all.
      steps: { worklist: jobbyWorklistStep(pool) },
    });

    // Run one tick
    await heartbeat.tick();

    return { ok: true, result: `Jobby heartbeat tick completed for ${workerId}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The worklist step: keep the candidate's list current, and say what is next.
 *
 * It deliberately does not MARK anything done. classifyAction() sorts each
 * action into agent-doable or candidate-only, and this step reports both, but
 * closing a candidate's action is theirs to do — a loop that ticks off
 * "Confirm your rate floor" because it read the word is manufacturing
 * progress, which is the failure this whole subsystem exists to prevent.
 *
 * ok:false when there is no dossier to build a list from. That is reported as a
 * failure on purpose: an empty queue must never be mistaken for an empty
 * calendar.
 */
function jobbyWorklistStep(pool) {
  return {
    run: async ({ clientId }) => {
      const { syncWorklist, nextAction, classifyAction } = await import('./jobby/worklist.mjs');

      const sync = await syncWorklist(pool, clientId);
      if (!sync.ok) {
        return { ok: false, note: sync.reason };
      }

      const next = await nextAction(pool, clientId);
      if (!next) {
        return { ok: true, note: `worklist current (${sync.inserted} new, ${sync.updated} refreshed); nothing open` };
      }

      const who = classifyAction(next.title, next.detail);
      return {
        ok: true,
        note: `next: [p${next.priority}] ${next.title} (${who.who})`,
      };
    },
  };
}

// ── Jobby Morning Summary Email ──────────────────────────────
export async function runJobbyMorningSummary() {
  try {
    const { getPool } = await import('./lib/db.mjs');
    const { composeCheckin } = await import('./jobby/composer.mjs');
    const { sendViaResend, resolveJobbySender } = await import('./server.js');
    
    const pool = await import('./lib/db.mjs').then(m => m.getPool());
    
    // Get all clients with claimed emails (active users)
    const { rows: clients } = await pool.query(`
      SELECT id, display_name, claimed_email, daily_send_cap
      FROM app.job_clients
      WHERE claimed_email IS NOT NULL
    `);
    
    if (!clients.length) {
      return { ok: true, result: 'No clients with claimed emails to notify' };
    }
    
    let sent = 0;
    let failed = 0;
    
    for (const client of clients) {
      try {
        // Get the day's plan for this client
        const { rows: planRows } = await pool.query(`
          SELECT priority, title, detail, track, status
          FROM app.job_actions
          WHERE client_id = $1 AND status IN ('pending', 'active')
          ORDER BY priority, track, id
        `, [client.id]);
        
        const plan = {
          actions: planRows.map(r => ({
            priority: r.priority,
            track: r.track,
            title: r.title,
            detail: r.detail,
            status: r.status
          }))
        };
        
        // Get recent cycles for context
        const { rows: cycleRows } = await pool.query(`
          SELECT decision, reason, status, steps, finished_at
          FROM app.job_cycles
          WHERE client_id = $1 AND finished_at > now() - INTERVAL '24 hours'
          ORDER BY finished_at DESC LIMIT 5
        `, [client.id]);
        
        const recentCycles = cycleRows.map(r => ({
          decision: r.decision,
          reason: r.reason,
          status: r.status,
          steps: r.steps,
          finished_at: r.finished_at
        }));
        
        // Build a dossier summary for the composer
        const { rows: clientInfo } = await pool.query(`
          SELECT display_name, email, phone, location
          FROM app.job_clients WHERE id = $1
        `, [client.id]);
        
        const dossier = {
          name: clientInfo[0]?.display_name || 'there',
          current_title: clientInfo[0]?.current_title || 'Professional',
          current_company: clientInfo[0]?.current_company || 'Self-employed',
          location: clientInfo[0]?.location
        };
        
        // Compose the morning email
        const email = composeCheckin({
          kind: 'progress',
          decision: 'Morning briefing',
          reason: `Your Jobby agent has ${plan.actions.filter(a => a.status === 'pending').length} pending actions for today`,
          dossier,
          plan: { actions: planRows.map(r => ({ title: r.title, status: r.status, track: r.track, priority: r.priority })) },
          recentCycles,
          client: { name: clientInfo[0]?.display_name || 'there', display_name: clientInfo[0]?.display_name }
        });
        
        // Send via Resend — first ensure the candidate has a jobbymcjobserson.com mailbox
        const { ensureCandidateMailbox } = await import('./server.js');
        const mailboxInfo = await ensureCandidateMailbox(client);
        console.log(`[Morning Summary] mailboxInfo for client ${client.id}:`, JSON.stringify(mailboxInfo));
        const sender = resolveJobbySender({ mailbox: mailboxInfo.mailbox, claimed_email: client.claimed_email });
        console.log(`[Morning Summary] sender for client ${client.id}:`, JSON.stringify(sender));
        // Use sender.address (raw email) for Resend's from field; formatted name is in the email body
        const fromAddress = sender.address || 'jobby@31harbor.com';
        console.log(`[Morning Summary] fromAddress for client ${client.id}:`, fromAddress);
        const result = await sendViaResend({
          from: fromAddress,
          to: client.claimed_email,
          subject: email.subject,
          text: email.body
        });
        console.log(`[Morning Summary] sendViaResend result for client ${client.id}:`, JSON.stringify(result));
        
        if (result.error) {
          failed++;
          console.error(`[Morning Summary] Failed to send to ${client.claimed_email}:`, result.error);
        } else {
          sent++;
          console.log(`[Morning Summary] Sent to ${client.claimed_email} (Resend ID: ${result.id})`);
        }
      } catch (e) {
        failed++;
        console.error(`[Morning Summary] Error for client ${client.id}:`, e.message);
      }
    }
    
    return { ok: true, result: `Morning summaries: ${sent} sent, ${failed} failed` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Jobby Evening Summary Email ──────────────────────────────
export async function runJobbyEveningSummary() {
  try {
    const { getPool } = await import('./lib/db.mjs');
    const { composeCheckin } = await import('./jobby/composer.mjs');
    const { sendViaResend, resolveJobbySender } = await import('./server.js');
    
    const pool = await import('./lib/db.mjs').then(m => m.getPool());
    
    // Get all clients with claimed emails
    const { rows: clients } = await pool.query(`
      SELECT id, display_name, claimed_email, daily_send_cap
      FROM app.job_clients
      WHERE claimed_email IS NOT NULL
    `);
    
    if (!clients.length) {
      return { ok: true, result: 'No clients with claimed emails to notify' };
    }
    
    let sent = 0;
    let failed = 0;
    
    for (const client of clients) {
      try {
        // Get today's completed work
        const { rows: completedRows } = await pool.query(`
          SELECT decision, reason, status, steps, finished_at
          FROM app.job_cycles
          WHERE client_id = $1 AND status IN ('ran', 'no_work')
            AND finished_at > CURRENT_DATE
          ORDER BY finished_at DESC
        `, [client.id]);
        
        // Get today's planned vs completed
        const { rows: plannedRows } = await pool.query(`
          SELECT title, status FROM app.job_actions
          WHERE client_id = $1 AND priority <= 2
          ORDER BY priority, track, id
        `, [client.id]);
        
        // Get dossier for context
        const { rows: clientInfo } = await pool.query(`
          SELECT display_name, email, phone, location
          FROM app.job_clients WHERE id = $1
        `, [client.id]);
        
        const dossier = {
          name: clientInfo[0]?.display_name || 'there',
          current_title: clientInfo[0]?.current_title || 'Professional',
          current_company: clientInfo[0]?.current_company || 'Self-employed',
          location: clientInfo[0]?.location
        };
        
        const completedCount = completedRows.filter(r => r.status === 'ran').length;
        const pendingPlanned = plannedRows.filter(r => r.status === 'pending').length;
        
        const email = composeCheckin({
          kind: 'progress',
          decision: `Day complete: ${completedCount} cycles ran`,
          reason: `${pendingPlanned} high-priority actions remain for tomorrow`,
          dossier: {
            name: clientInfo[0]?.display_name || 'there',
            current_title: clientInfo[0]?.current_title,
            current_company: clientInfo[0]?.current_company
          },
          plan: { actions: plannedRows.map(r => ({ title: r.title, status: r.status })) },
          recentCycles: completedRows.map(r => ({
            decision: r.decision,
            reason: r.reason,
            status: r.status,
            steps: r.steps,
            finished_at: r.finished_at
          })),
          client: { name: clientInfo[0]?.display_name || 'there', display_name: clientInfo[0]?.display_name }
        });
        
        const { ensureCandidateMailbox } = await import('./server.js');
        const mailboxInfo = await ensureCandidateMailbox(client);
        const sender = resolveJobbySender({ mailbox: mailboxInfo.mailbox, claimed_email: client.claimed_email });
        const result = await sendViaResend({
          from: sender.address || 'jobby@31harbor.com',
          to: client.claimed_email,
          subject: email.subject,
          text: email.body
        });
        
        if (result.error) {
          failed++;
          console.error(`[Evening Summary] Failed to send to ${client.claimed_email}:`, result.error);
        } else {
          sent++;
          console.log(`[Evening Summary] Sent to ${client.claimed_email} (Resend ID: ${result.id})`);
        }
      } catch (e) {
        failed++;
        console.error(`[Evening Summary] Error for client ${client.id}:`, e.message);
      }
    }
    
    return { ok: true, result: `Evening summaries: ${sent} sent, ${failed} failed` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runEdgeFunctionByName(fnName, body = {}) {
  const target = `${RUNTIME_URL}/functions/v1/${fnName}`;
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    // Surface how many rows the function says it changed. A 200 with no count
    // is not evidence that anything happened; the task loops used to report
    // {"rows": null} and "ran" was mistaken for "did something".
    const rows = typeof parsed?.rows === 'number'
      ? parsed.rows
      : typeof parsed?.update_summary?.rows === 'number'
        ? parsed.update_summary.rows
        : typeof parsed?.advance_summary?.rows === 'number'
          ? parsed.advance_summary.rows
          : null;
    // A failure MUST carry its reason. The result used to be
    // {ok, status, rows, preview} with no error field, and the reporter -
    // which reports `error` - then wrote "failed with no reason reported by
    // the job" for every non-2xx edge response. The actual cause
    // ("Title and content (markdown or body) are required.") was in the
    // preview and in the response body, and nowhere else. Two jobs have
    // been failing on that blank line.
    if (!r.ok) {
      const detail = (typeof parsed?.error === 'string' && parsed.error)
        || (typeof parsed?.message === 'string' && parsed.message)
        || text.slice(0, 200).trim()
        || '(empty response body)';
      return {
        ok: false,
        status: r.status,
        rows,
        preview: text.slice(0, 200),
        error: `edge function "${fnName}" returned HTTP ${r.status}: ${detail}`,
      };
    }
    return { ok: true, status: r.status, rows, preview: text.slice(0, 200) };
  } catch (e) {
    // An aborted edge call used to report "The operation was aborted due to
    // timeout", which does not say WHICH function, or how long it was given.
    // extract-knowledge timed out three times in three days and the log line
    // could not tell it apart from any other timed-out call.
    const aborted = e?.name === 'TimeoutError' || /abort/i.test(e?.message || '');
    return {
      ok: false,
      error: aborted
        ? `edge function "${fnName}" timed out after 60000ms (${target})`
        : `edge function "${fnName}" failed: ${e?.message || e}`,
    };
  }
}

async function runEdgeFunction(job) {
  // Legacy: parse the command string for the function name.
  const m = job.command?.match(/functions\/v1\/([a-zA-Z0-9_-]+)/);
  if (!m) return { ok: false, error: 'no function name in command' };
  return runEdgeFunctionByName(m[1], {});
}

// ── Python Job Runner ─────────────────────────────────────
// Executes Python code on the relay's python-exec tool.
// The job's `code` field contains the Python script.
async function runPythonJob(code) {
  if (!code) return { ok: false, error: 'no code in job definition' };
  if (!RELAY_API_KEY) {
    return {
      ok: false,
      error: 'RELAY_API_KEY is not set. The cron engine is started by the supervisor, which loads relay/.env.',
    };
  }
  try {
    const res = await fetch('http://127.0.0.1:8080/tools/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': RELAY_API_KEY,
        'x-agent-id': 'cron',
      },
      body: JSON.stringify({ tool: 'python-exec', args: { code, timeout: 120 } }),
      signal: AbortSignal.timeout(130_000),
    });
    const data = await res.json();
    if (data.success) {
      return { ok: true, result: data.output?.slice(0, 500) || '(empty)', rows: data.length };
    }
    return { ok: false, error: data.error || data.stderr || 'python-exec failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Robust Shell Command Runner ────────────────────────────────────
// The old implementation used promisify(exec)(cmd, { timeout }). On Windows
// Node, exec's timeout path calls child.kill() which races the process 'exit'/
// 'close' events and triggers a FATAL libuv abort:
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c
// (e.g. task-discussion-announcer running node relay/task-announcer.mjs every
// 15 min). That assertion is a hard process crash -- uncaughtException cannot
// catch it. Use spawn() and manage the lifecycle ourselves: wait for the real
// 'close' event (all stdio drained + handle settled) and always clear the
// timer before resolving, so a timer kill can never race a closing handle.
import { spawn } from 'node:child_process';

/**
 * Turn a non-zero shell exit into a sentence somebody can act on.
 *
 * The exit code is the fact; the child's stderr is the reason. Both are
 * wanted: "exit 1" alone says the job broke and nothing about why, and the
 * stderr alone loses the fact that it was this job that broke.
 *
 * The TAIL of stderr is used, not the head. These scripts print their reason
 * last ("[heartbeat] FAIL: fetch failed"), and a job that printed a stack
 * trace first would otherwise have its actual message cut off.
 */
export function describeShellFailure(code, signal, stderr = '', stdout = '') {
  const text = String(stderr || '').trim() || String(stdout || '').trim();
  const how = code === null || code === undefined
    ? (signal ? `killed by ${signal}` : 'killed')
    : `exit ${code}`;
  const tail = text ? `: ${text.slice(-300)}` : ' (the job printed nothing)';
  return `shell command ${how}${tail}`;
}

/**
 * Is this failure worth trying again?
 *
 * The relay is a dependency of most of the shell jobs - they fetch
 * http://127.0.0.1:8080 to do their work - and the relay stops answering for
 * a few seconds at a time when it is busy. On 2026-10-22 that produced
 * "relay-health-check failed", "fleet-chat-productivity-agent failed",
 * "escalate-waiting-tasks failed" and "fleet-summary-announcer failed" within
 * a minute of each other, four failures for one cause, none of them the fault
 * of the four jobs.
 *
 * A connectivity failure is worth one more attempt, because the job never got
 * to do its work at all. A job that ran and produced a wrong answer is not:
 * re-running that is how a loop starts.
 *
 * The patterns are the ones Node and undici actually print for "the peer was
 * not there", plus the phrase these scripts print when their fetch times out.
 */
const TRANSIENT_PATTERNS = [
  'econnrefused',
  'econnreset',
  'ehostunreach',
  'enetunreach',
  'epipe',
  'etimedout',
  'eai_again',
  'fetch failed',
  'socket hang up',
  'aborted due to timeout',
  'connection refused',
  'connection reset',
  'server is not responding',
];

export function looksTransient(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return TRANSIENT_PATTERNS.some((p) => t.includes(p));
}

export async function runShellCommand(command, { timeoutMs = 120_000, cwd = __dirname } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // spawn with shell:true passes the whole command string through the OS
      // shell (cmd.exe on Windows), preserving the original exec() behavior.
      child = spawn(command, { cwd, windowsHide: true, shell: true });
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill the child, then wait for 'close' before resolving (no UV race).
      try { child.kill(); } catch {}
      const timeoutError = `shell command timed out after ${timeoutMs}ms`
        + (stderr.trim() ? `: ${stderr.trim().slice(-300)}` : '');
      // Guard: if the child never closes, resolve anyway after a grace period.
      const grace = setTimeout(() => resolve({ ok: false, error: timeoutError, timedOut: true, stderr: stderr.slice(-500) }), 5000);
      child.once('close', () => { clearTimeout(grace); resolve({ ok: false, error: timeoutError, timedOut: true, stderr: stderr.slice(-500) }); });
    }, timeoutMs);

    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, stderr: stderr.slice(-500) });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, rows: stdout.length, stdout: stdout.slice(-500), stderr: stderr.slice(-500), exitCode: code });
        return;
      }
      // A non-zero exit is a failure, and a failure with no reason is a
      // failure nobody can fix. This branch used to return `ok:false` and
      // nothing else, so the caller logged `res.error` - which was undefined -
      // and the log said "FAIL: undefined" and the audit row's error column
      // was empty. The reason was sitting in stderr, thrown away.
      resolve({
        ok: false,
        error: describeShellFailure(code, signal, stderr, stdout),
        rows: stdout.length,
        stdout: stdout.slice(-500),
        stderr: stderr.slice(-500),
        exitCode: code,
        signal,
      });
    });
  });
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: {} }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}



// Shared Context Writer and TTL-pruning/Dispatch-filter fixes

// ── Shared Context Writer ──────────────────────────────────

// Writes TTL-tracked entries to shared_context for scanner pruning

// and workflow engine dispatch filtering.
async function writeSharedContext(entry) {
  try {
    const pool = getSharedPool();
    const ttlMinutes = entry.ttl_minutes || 90;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
    // Two bugs were here. The column names were all wrong — the table is
    // (id, context_key, context_type, value, description, tags,
    // last_updated_by, created_at, updated_at) and this named `key`,
    // `ttl_minutes`, `expires_at` and `agent`, none of which exist. And the
    // statement had five placeholders with no parameter array passed at all.
    //
    // Together they meant this could never succeed. The catch turned the failure
    // into a WARN line, callers carried on, and the scanner's shared context was
    // silently never written - it looked healthy because nothing threw.
    //
    // There is no TTL column, so the expiry travels inside the value instead of
    // being discarded, where a reader can see it and pruning can act on it.
    const payload = (() => {
      try {
        const parsed = JSON.parse(entry.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return JSON.stringify({ ...parsed, _expires_at: expiresAt, _ttl_minutes: ttlMinutes });
        }
        return JSON.stringify({ value: parsed, _expires_at: expiresAt, _ttl_minutes: ttlMinutes });
      } catch {
        return entry.value;
      }
    })();
    await pool.query(
      `INSERT INTO public.shared_context (context_key, context_type, value, last_updated_by, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW(), NOW())
       ON CONFLICT (context_key) DO UPDATE
       SET value = EXCLUDED.value,
           context_type = EXCLUDED.context_type,
           last_updated_by = EXCLUDED.last_updated_by,
           updated_at = NOW()`,
      [entry.key, entry.context_type || 'general', payload, entry.agent || 'cron-engine-v2']
    );
    return { ok: true };
  } catch (e) {
    log(`writeSharedContext: DB error: ${e.message}`, 'WARN');
    return { ok: false, error: e.message };
  }
}

// Scanner Pruning & Deduplication
// Runs after arch-ecosystem-scanner execution to TTL-prune stale items,
// track acknowledgments, and mark duplicates with no-reemit guard.
async function pruneScannerItems() {
  try {
    const pool = getSharedPool();
    // The column is context_key, not key. Verified against the live table:
    //   public.shared_context (id uuid, context_key text, context_type text,
    //   value jsonb, description text, tags text[], last_updated_by text,
    //   created_at, updated_at)
    // Querying WHERE key = ... threw `column "key" does not exist` on every
    // single tick - roughly every 30 seconds, forever - which is how a 53MB
    // log file accumulated. The error was caught and warned, so the prune
    // silently never ran rather than crashing anything.
    const scanRes = await pool.query(
      `SELECT value FROM public.shared_context WHERE context_key = 'arch-ecosystem-scan'`
    );
    let scanItems = [];
    if (scanRes.rows.length > 0) {
      try {
        // value is jsonb, so node-postgres already handed us a parsed object.
        // JSON.parse would throw on anything that is not a string, which is why
        // this accepts both rather than assuming one shape.
        const v = scanRes.rows[0].value;
        scanItems = typeof v === 'string' ? JSON.parse(v || '[]') : (Array.isArray(v) ? v : []);
      } catch (e) {
        log(`pruneScannerItems: failed to parse scan output: ${e.message}`, 'WARN');
        scanItems = [];
      }
    }
    if (scanItems.length === 0) {
      log('pruneScannerItems: no scanner items to prune');
      return { ok: true };
    }
    const THRESHOLD_MS = 6 * 60 * 60 * 1000;
    const now = Date.now();
    let kept = 0, dropped = 0, markedDuplicate = 0;
    const processed = scanItems.map(item => {
      const itemAge = now - (item.nudged_at || item.created_at || now);
      const isResolved = item.status === 'resolved' || item.status === 'done' || item.status === 'closed';
      const isAcknowledged = item.acknowledged_at !== undefined;
      const isDuplicate = item.isDuplicate === true;
      if ((isResolved || isAcknowledged || isDuplicate) && itemAge > THRESHOLD_MS) {
        dropped++;
        return { ...item, toKeep: false, action: isResolved ? 'resolved-drop' : (isAcknowledged ? 'ack-drop' : 'duplicate-drop') };
      }
      if (!isDuplicate) { markedDuplicate++; return { ...item, toKeep: true, action: 'kept' }; }
      kept++;
      return { ...item, toKeep: true, action: 'kept-unresolved' };
    }).filter(p => p.toKeep);
    if (processed.length > 0 || dropped > 0) {
      await writeSharedContext({
        key: 'arch-ecosystem-scan',
        value: JSON.stringify(processed),
        ttl_minutes: 360,
        expires_at: new Date(Date.now() + 360 * 60000).toISOString(),
        agent: 'cron-engine-v2'
      });
    }
    log(`pruneScannerItems: kept=${processed.length}, dropped=${dropped}, markedDuplicate=${markedDuplicate}, totalIn=${scanItems.length}`);
    return { ok: true, kept, dropped, markedDuplicate, totalIn: scanItems.length };
  } catch (e) {
    log(`pruneScannerItems: error: ${e.message}`, 'ERROR');
    return { ok: false, error: e.message };
  }
}

// Workflow Engine Dispatch Filter Update
// Changes the fleet-chat-task-creator to use live tasks table query
// instead of string-matching conversation history.
// New filter: assignee_agent_id = eliza-001 AND status IN (PENDING, CLAIMED, IN_PROGRESS)
async function updateWorkflowDispatchFilter() {
  try {
    const pool = getSharedPool();
    const taskRes = await pool.query(
      `SELECT id, title, status, stage, priority, assignee_agent_id FROM public.tasks WHERE assignee_agent_id = 'eliza-001' AND status IN ('PENDING', 'CLAIMED', 'IN_PROGRESS') ORDER BY priority DESC, created_at DESC`
    );
    const activeTasks = taskRes.rows.map(t => ({ id: t.id, title: t.title, status: t.status, stage: t.stage, priority: t.priority }));
    await writeSharedContext({
      key: 'eliza-active-tasks',
      value: JSON.stringify(activeTasks),
      ttl_minutes: 30,
      expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
      agent: 'cron-engine-v2'
    });
    log(`updateWorkflowDispatchFilter: loaded ${activeTasks.length} active eliza-001 tasks from live table`);
    return { ok: true, count: activeTasks.length };
  } catch (e) {
    log(`updateWorkflowDispatchFilter: DB error: ${e.message}`, 'WARN');
    return { ok: true };
  }
}


async function tick() {
  const jobs = await loadJobsFromPg();
  if (!jobs.length) {
    log('no jobs registered');
    return;
  }
  log(`loaded ${jobs.length} jobs (${jobs.filter(j => j.type === 'sql').length} sql, ${jobs.filter(j => j.type === 'edge').length} edge)`);
  const state = loadState();
  for (const job of jobs) {
    if (job.disabled) continue;
    const lastMin = state.lastRun[job.id];
    const thisMin = Math.floor(Date.now() / 60000);
    if (lastMin === thisMin) continue; // already ran this minute
    // Due if the schedule matched at any minute since this job last ran.
    // A job that has never run is judged on the current minute only, so a
    // fresh engine does not fire the whole board at once.
    const sinceMs = (lastMin === undefined ? thisMin : lastMin) * 60000;
    const due = cronDueSince(job.schedule, sinceMs, Date.now());
    if (due.error) {
      log(`job ${job.id} bad cron: ${due.error}`, 'WARN');
      continue;
    }
    if (!due.due) continue;
    const label = job.name || job.fn || `job-${job.id}`;
    log(`[${job.id}] ${job.type}: ${label}`);
    const startedAt = new Date();
    let res;
    // ONE JOB MUST NOT ABORT THE TICK.
    //
    // A throw here - a database that went away mid-run, a job type that
    // reaches for something undefined - used to escape tick() entirely. The
    // daemon caught it ("tick error: ...") and every job AFTER the one that
    // threw was silently skipped for that minute: no run, no log line, no
    // audit row. The log even recorded those minutes as "loaded 106 jobs",
    // which reads like work happened.
    //
    // A job that throws is a job that failed. It is recorded as a failure,
    // with its reason, and the tick carries on.
    try {
      if (job.type === 'sql') {
        res = await runSql(job.command);
      } else if (job.type === 'edge' && job.fn) {
        res = await runEdgeFunctionByName(job.fn, job.body);
      } else if (job.type === 'local' && job.action === 'fleet-chat-heartbeat') {
        res = await runFleetChatHeartbeat();
      } else if (job.type === 'local' && job.action === 'fleet-chat-followup') {
        res = await runFleetChatFollowUp();
      } else if (job.type === 'local' && job.action === 'fleet-chat-task-creator') {
        res = await runFleetChatTaskCreator();
      } else if (job.type === 'local' && job.action === 'jobby-heartbeat') {
        res = await runJobbyHeartbeat();
      } else if (job.type === 'local' && job.action === 'jobby-morning-summary') {
        res = await runJobbyMorningSummary();
      } else if (job.type === 'local' && job.action === 'jobby-evening-summary') {
        res = await runJobbyEveningSummary();
      } else if (job.type === 'python' && job.code) {
        res = await runPythonJob(job.code);
      } else if (job.type === 'shell') {
        // Execute shell commands via child_process. Use async exec (NOT execSync)
        // so the relay's event loop is not blocked. execSync would block the
        // relay from serving the very HTTP requests these shell jobs make back
        // to localhost:8080, causing them to time out (e.g. trustgraph-scanner,
        // health-check, fleet-chat-heartbeat all fetch the relay).
        try {
          res = await runShellCommand(job.command, { timeoutMs: 120_000, cwd: join(__dirname, '..') });
        } catch (e) {
          res = { ok: false, error: e.message };
        }
        // ONE MORE ATTEMPT, FOR A DEPENDENCY THAT WAS NOT THERE.
        //
        // These jobs call back into the relay on 127.0.0.1:8080, and the relay
        // stops answering for a few seconds at a time when it is busy. When
        // that happened, four unrelated jobs failed within a minute of each
        // other for one reason, and none of them had done anything wrong.
        //
        // The retry is only for connectivity failures, and only when the job
        // printed nothing: a job that got as far as producing output may
        // already have done its work, and running it again is how a
        // double-post happens. A job that ran and got it wrong is not
        // retried - that is a bug to fix, not a blip to wait out.
        if (!res.ok && !res.stdout?.trim() && looksTransient(res.error)) {
          log(`[${job.id}] ${label}: transient failure (${res.error}); retrying in ${TRANSIENT_RETRY_DELAY_MS}ms`, 'WARN');
          await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
          try {
            const retry = await runShellCommand(job.command, { timeoutMs: 120_000, cwd: join(__dirname, '..') });
            if (retry.ok) {
              retry.retried = true;
              res = retry;
            } else {
              res = { ...retry, firstAttemptError: res.error };
            }
          } catch (e) {
            res = { ok: false, error: e.message, firstAttemptError: res.error };
          }
        }
      } else {
        res = { ok: false, error: `unknown type: ${job.type}` };
      }
    } catch (e) {
      res = { ok: false, error: e?.message || String(e) };
    }
    state.lastRun[job.id] = thisMin;
    // Write to the dedicated tracking tables (cron_execution_log,
    // edge_function_logs, cron_registry) + eliza_activity_log feed.
    try {
      await logCronExecution(job, res, startedAt);
    } catch (e) {
      log(`[${job.id}] could not record its own execution: ${e?.message || e}`, 'WARN');
    }
    if (res.ok) {
      log(`[${job.id}] OK (${res.rows ?? res.status ?? '?'} rows/ms)${res.retried ? ' (after a transient failure)' : ''}`);
    } else {
      const reason = jobErrorText(res) || 'no reason recorded';
      log(`[${job.id}] FAIL: ${reason}`, 'WARN');
    }
  }
  saveState(state);

  // After all jobs have run, perform post-tick maintenance:
  //   1. TTL-prune scanner items & track acknowledgments (Ghost loop fix)
  //   2. Update workflow dispatch filter from live tasks table
  try {
    const pruneRes = await pruneScannerItems();
    if (pruneRes.ok) {
      log('pruneScannerItems: kept=' + (pruneRes.kept || 0) + ', dropped=' + (pruneRes.dropped || 0) + ', markedDuplicate=' + (pruneRes.markedDuplicate || 0));
    } else {
      log('pruneScannerItems: ' + (pruneRes.error || 'unknown error'), 'WARN');
    }
  } catch (e) {
    log('pruneScannerItems: unexpected error: ' + e.message, 'ERROR');
  }
  try {
    const dispatchRes = await updateWorkflowDispatchFilter();
    if (dispatchRes.ok) {
      log('updateWorkflowDispatchFilter: loaded ' + (dispatchRes.count || 0) + ' active eliza-001 tasks from live table');
    } else {
      log('updateWorkflowDispatchFilter: ' + (dispatchRes.error || 'unknown error'), 'WARN');
    }
  } catch (e) {
    log('updateWorkflowDispatchFilter: unexpected error: ' + e.message, 'ERROR');
  }
}

export async function runOnce() {
  await tick();
}

export function runDaemon() {
  log('daemon starting (poll every 30s)');
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { await tick(); } catch (e) { log('tick error: ' + e.message, 'WARN'); }
    setTimeout(loop, 30_000);
  };
  loop();
  return () => { stopped = true; };
}

// CLI mode
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  if (process.argv.includes('--once')) {
    runOnce().then(() => process.exit(0));
  } else if (process.argv.includes('--list')) {
    loadJobsFromPg().then((j) => { console.log(JSON.stringify(j, null, 2)); process.exit(0); });
  } else {
    runDaemon();
  }
}
