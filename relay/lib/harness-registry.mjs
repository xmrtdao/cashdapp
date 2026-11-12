// harness-registry.mjs — Unified agent harness management
//
// Tracks all agent harnesses (OpenClaw, Pi, Hermes, DSH, OpenCode, etc.)
// in app.harnesses. Provides CRUD, health checks, and capability matching.
//
// This is the foundation for the OpenHands integration: a single control
// plane for all local agent runtimes.

// queryLocalPg is passed in by the caller (relay/server.js). No import needed.

export const HARNESS_TYPES = [
  'openclaw', 'pi', 'hermes', 'dsh', 'opencode', 'claude-code',
  'qwen-code', 'ollama', 'custom',
];

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
  const { id, name, type, endpoint, status, capabilities, config, metadata } = harness;
  const r = await queryLocalPg(
    `INSERT INTO app.harnesses (id, name, type, endpoint, status, capabilities, config, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE($2, app.harnesses.name),
       type = COALESCE($3, app.harnesses.type),
       endpoint = COALESCE($4, app.harnesses.endpoint),
       status = COALESCE($5, app.harnesses.status),
       capabilities = COALESCE($6, app.harnesses.capabilities),
       config = COALESCE($7, app.harnesses.config),
       metadata = COALESCE($8, app.harnesses.metadata),
       updated_at = NOW()
     RETURNING *`,
    [id, name, type, endpoint || null, status || 'unknown',
     capabilities || [], JSON.stringify(config || {}), JSON.stringify(metadata || {})]
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
 * Check health of a harness by pinging its endpoint.
 */
export async function checkHarnessHealth(harness) {
  if (!harness.endpoint) return { status: 'unknown', error: 'no endpoint' };
  // Type-specific health endpoints
  const healthPath = harness.type === 'ollama' ? '/api/tags' : '/health';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(harness.endpoint + healthPath, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) return { status: 'healthy', error: null };
    return { status: 'degraded', error: `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'down', error: e.message };
  }
}

/**
 * Run health checks on all harnesses and update their status.
 */
export async function runHealthChecks(queryLocalPg) {
  const harnesses = await listHarnesses(queryLocalPg);
  const results = [];
  for (const h of harnesses) {
    const health = await checkHarnessHealth(h);
    await updateHarnessHealth(queryLocalPg, h.id, { status: health.status, error: health.error });
    results.push({ id: h.id, name: h.name, ...health });
  }
  return results;
}