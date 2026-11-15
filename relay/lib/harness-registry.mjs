// harness-registry.mjs — Unified agent harness management
//
// Tracks all agent harnesses (OpenClaw, Pi, Hermes, DSH, OpenCode, etc.)
// in app.harnesses. Provides CRUD, health checks, and capability matching.
//
// This is the foundation for the OpenHands integration: a single control
// plane for all local agent runtimes.

// queryLocalPg is passed in by the caller (relay/server.js). No import needed.

import { execSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';

export const HARNESS_TYPES = [
  'openclaw', 'pi', 'hermes', 'dsh', 'opencode', 'claude-code',
  'qwen-code', 'ollama', 'openfilm', 'tts', 'custom',
];

/**
 * The health verdicts the registry can hold.
 *
 * 'not-installed' exists because "unknown" and "down" both used to mean
 * "there is no endpoint", which is indistinguishable from "the runtime is
 * broken". A dashboard that cannot tell those apart shows a wall of red for
 * runtimes that were never installed, and a green light for one that stopped
 * answering six days ago.
 */
export const HARNESS_STATUSES = ['healthy', 'degraded', 'down', 'not-installed', 'unknown'];

/**
 * List all harnesses, optionally filtered by status or type.
 */
export async function listHarnesses(queryLocalPg, { status, type } = {}) {
  let sql = 'SELECT * FROM app.harnesses WHERE 1=1';
  const params = [];
  let idx = 0;
  if (status) { idx++; sql += ` AND status = $${idx}`; params.push(status); }
  if (type) { idx++; sql += ` AND type = $${idx}`; params.push(type); }
  sql += ' ORDER BY name';
  const r = await queryLocalPg(sql, params);
  return r.rows || [];
}

/**
 * Get a single harness by id.
 */
export async function getHarness(queryLocalPg, id) {
  const r = await queryLocalPg('SELECT * FROM app.harnesses WHERE id = $1', [id]);
  return (r.rows || [])[0] || null;
}

/**
 * Create or update a harness.
 */
export async function upsertHarness(queryLocalPg, harness) {
  const {
    id, name, type, endpoint, status, capabilities, config, metadata,
    health_mode, health_path, health_process, ui_endpoint, install_hint, supervised,
  } = harness;
  const r = await queryLocalPg(
    `INSERT INTO app.harnesses
       (id, name, type, endpoint, status, capabilities, config, metadata,
        health_mode, health_path, health_process, ui_endpoint, install_hint, supervised, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE($2, app.harnesses.name),
       type = COALESCE($3, app.harnesses.type),
       endpoint = COALESCE($4, app.harnesses.endpoint),
       status = COALESCE($5, app.harnesses.status),
       capabilities = COALESCE($6, app.harnesses.capabilities),
       config = COALESCE($7, app.harnesses.config),
       metadata = COALESCE($8, app.harnesses.metadata),
       health_mode = COALESCE($9, app.harnesses.health_mode),
       health_path = COALESCE($10, app.harnesses.health_path),
       health_process = COALESCE($11, app.harnesses.health_process),
       ui_endpoint = COALESCE($12, app.harnesses.ui_endpoint),
       install_hint = COALESCE($13, app.harnesses.install_hint),
       supervised = COALESCE($14, app.harnesses.supervised),
       updated_at = NOW()
     RETURNING *`,
    [id, name, type, endpoint || null, status || 'unknown',
     capabilities || [], JSON.stringify(config || {}), JSON.stringify(metadata || {}),
     health_mode || 'http', health_path || null, health_process || null,
     ui_endpoint || null, install_hint || null, supervised ?? false]
  );
  return (r.rows || [])[0] || null;
}

/**
 * Update harness health status.
 */
export async function updateHarnessHealth(queryLocalPg, id, { status, error, pid }) {
  const sets = ['status = $2', 'last_health_check = NOW()', 'updated_at = NOW()'];
  const params = [id, status];
  let idx = 2;
  if (error !== undefined) { idx++; sets.push(`last_health_error = $${idx}`); params.push(error); }
  if (pid !== undefined) { idx++; sets.push(`pid = $${idx}`); params.push(pid); }
  if (status === 'healthy') { sets.push('started_at = COALESCE(started_at, NOW())'); }
  const r = await queryLocalPg(
    `UPDATE app.harnesses SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return (r.rows || [])[0] || null;
}

/**
 * Update harness load.
 */
export async function updateHarnessLoad(queryLocalPg, id, load) {
  const r = await queryLocalPg(
    `UPDATE app.harnesses SET current_load = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, load]
  );
  return (r.rows || [])[0] || null;
}

/**
 * Find the best harness for a task based on capability match, health, and load.
 */
export async function findBestHarness(queryLocalPg, { category, capabilities = [] }) {
  const harnesses = await listHarnesses(queryLocalPg, { status: 'healthy' });
  if (harnesses.length === 0) return null;

  // Score each harness
  const scored = harnesses.map(h => {
    let score = 0;
    const caps = h.capabilities || [];
    // Capability match
    for (const c of capabilities) {
      if (caps.includes(c)) score += 10;
    }
    if (category && caps.includes(category)) score += 5;
    // Load penalty (prefer less loaded)
    score -= (h.current_load || 0) * 2;
    // Trust: prefer higher trust (if available in metadata)
    return { harness: h, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.harness || null;
}

/**
 * Split an endpoint URL into host and port.
 */
function endpointParts(endpoint) {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Is something listening on this TCP port?
 */
function checkTcpPort(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { try { socket.destroy(); } catch {} resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Is there a running process whose command line contains this text?
 *
 * Used for harnesses with no network interface at all - Hermes is a stdio
 * gateway, so the only way to ask whether it is alive is to look for it.
 */
function isProcessRunningMatching(needle) {
  const want = String(needle || '').toLowerCase();
  if (!want) return false;
  try {
    const out = execSync(
      `wmic process get ProcessId,CommandLine /format:csv`,
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000, encoding: 'utf8', windowsHide: true }
    );
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('Node,')) continue;
      if (t.toLowerCase().includes(want)) return true;
    }
  } catch {
    // If the process table cannot be read, that is not evidence of absence.
    return false;
  }
  return false;
}

/**
 * Check health of a harness by the mode it declares.
 *
 * The mode decides HOW to ask, because not every runtime has an HTTP
 * endpoint to ask:
 *
 *   http    GET endpoint + health_path. A 401/403 counts as ALIVE - it is an
 *           auth wall, and a wall means something is listening.
 *   tcp     connect to the endpoint's port. For harnesses whose HTTP root
 *           answers 401 by design.
 *   process look for a live command line. For stdio gateways.
 *   files   the path exists on disk. For local model directories.
 *   none    not installed; there is nothing to probe.
 */
export async function checkHarnessHealth(harness) {
  const mode = harness.health_mode || 'http';

  if (mode === 'none') {
    return {
      status: 'not-installed',
      error: harness.install_hint || 'not installed on this machine',
    };
  }

  if (mode === 'files') {
    const p = harness.health_path;
    if (!p) return { status: 'unknown', error: 'no path to check' };
    try {
      return existsSync(p)
        ? { status: 'healthy', error: null }
        : { status: 'down', error: `missing ${p}` };
    } catch (e) {
      return { status: 'down', error: e.message };
    }
  }

  if (mode === 'process') {
    const needle = harness.health_process || harness.type;
    if (!needle) return { status: 'unknown', error: 'no process pattern' };
    return isProcessRunningMatching(needle)
      ? { status: 'healthy', error: null }
      : { status: 'down', error: `no running process matching "${harness.health_process || harness.type}"` };
  }

  const parts = endpointParts(harness.endpoint);

  if (mode === 'tcp') {
    if (!parts) return { status: 'unknown', error: 'no endpoint to probe' };
    return (await checkTcpPort(parts.host, parts.port))
      ? { status: 'healthy', error: null }
      : { status: 'down', error: `port ${parts.port} is not listening` };
  }

  // http
  if (!harness.endpoint) {
    return { status: 'not-installed', error: harness.install_hint || 'no endpoint' };
  }
  const healthPath = harness.health_path || '/health';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(harness.endpoint + healthPath, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) return { status: 'healthy', error: null };
    if (res.status === 401 || res.status === 403) {
      // The harness is up and asking for credentials. That IS healthy - it
      // is a local UI with an auth wall, and counting it as a failure is how
      // dsh ended up marked down while it was serving.
      return { status: 'healthy', error: `auth wall (HTTP ${res.status})` };
    }
    return { status: 'degraded', error: `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'down', error: e.message };
  }
}

/**
 * Run health checks on all harnesses and update their status.
 *
 * The checks run in PARALLEL. They used to run one after another, each with
 * a five-second timeout, so a single unreachable harness held the whole pass
 * for five seconds and ten of them took the best part of a minute.
 *
 * A row is only written when its verdict actually changed. updated_at is
 * meant to say "this was last re-checked at", and a column that moves every
 * minute regardless of the answer cannot mean that.
 */
export async function runHealthChecks(queryLocalPg) {
  const harnesses = await listHarnesses(queryLocalPg);
  const checks = await Promise.all(harnesses.map(async (h) => {
    const health = await checkHarnessHealth(h);
    return { h, health };
  }));

  const results = [];
  for (const { h, health } of checks) {
    const changed = h.status !== health.status || (h.last_health_error || null) !== (health.error || null);
    if (changed) {
      await updateHarnessHealth(queryLocalPg, h.id, { status: health.status, error: health.error });
    } else {
      // Still refresh the timestamp: the point is to say when it was last ASKED.
      await queryLocalPg('UPDATE app.harnesses SET last_health_check = NOW() WHERE id = $1', [h.id]);
    }
    results.push({ id: h.id, name: h.name, type: h.type, ...health, changed });
  }
  return results;
}

/**
 * A count-by-status summary, for the dashboard header.
 */
export function summarizeHarnesses(harnesses) {
  const counts = { healthy: 0, degraded: 0, down: 0, 'not-installed': 0, unknown: 0 };
  for (const h of harnesses) {
    const s = counts[h.status] !== undefined ? h.status : 'unknown';
    counts[s]++;
  }
  counts.total = harnesses.length;
  counts.installed = counts.total - counts['not-installed'];
  counts.available = counts.healthy + counts.degraded;
  return counts;
}