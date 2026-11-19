/**
 * relay/lib/openproject.mjs — minimal OpenProject REST API v3 client
 *
 * OpenProject is the consolidation UI for the XMRT task pipeline. After the
 * schema unification (app.tasks is canonical), tasks are pushed here so the
 * operator gets a single board instead of the fragmented app/public/agent
 * tables. This module is a thin, dependency-free wrapper over the REST API;
 * it does not run OpenProject itself — that must be stood up separately.
 *
 * Config (relay/.env):
 *   OPENPROJECT_URL   base URL, e.g. http://127.0.0.1:3000 (default)
 *   OPENPROJECT_API_KEY   API token (Basic auth: "apikey:<token>")
 *
 * OpenProject REST v3 reference:
 *   https://www.openproject.org/docs/api/endpoints/
 */

const OP_URL = () => (process.env.OPENPROJECT_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const OP_KEY = () => process.env.OPENPROJECT_API_KEY || '';

function authHeaders() {
  const key = OP_KEY();
  if (!key) throw new Error('OPENPROJECT_API_KEY is not set in relay/.env');
  return {
    'Authorization': 'Basic ' + Buffer.from('apikey:' + key).toString('base64'),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function opFetch(path, opts = {}) {
  const url = OP_URL() + (path.startsWith('/') ? path : '/' + path);
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 300);
    throw new Error(`OpenProject ${opts.method || 'GET'} ${path} -> ${res.status}: ${msg}`);
  }
  return json;
}

/** Health / connectivity check. */
export async function opHealth() {
  try {
    const me = await opFetch('/api/v3/users/me');
    return { ok: true, user: me?.name || me?.login || 'unknown', url: OP_URL() };
  } catch (e) {
    return { ok: false, error: e.message, url: OP_URL() };
  }
}

/** List projects (used to pick the target project for task sync). */
export async function opListProjects() {
  const data = await opFetch('/api/v3/projects');
  return (data?._embedded?.elements || []).map(p => ({ id: p.id, identifier: p.identifier, name: p.name }));
}

/** List work package types for a project (Task, Bug, Feature, ...). */
export async function opListTypes(projectId) {
  const data = await opFetch(`/api/v3/projects/${projectId}/types`);
  return (data?._embedded?.elements || []).map(t => ({ id: t.id, name: t.name }));
}

/** List statuses. */
export async function opListStatuses() {
  const data = await opFetch('/api/v3/statuses');
  return (data?._embedded?.elements || []).map(s => ({ id: s.id, name: s.name, isClosed: s.isClosed }));
}

/** List work packages for a project. */
export async function opListWorkPackages(projectId, limit = 50) {
  const data = await opFetch(`/api/v3/projects/${projectId}/work_packages?pageSize=${limit}`);
  return (data?._embedded?.elements || []).map(wp => ({
    id: wp.id, subject: wp.subject, type: wp._links?.type?.title,
    status: wp._links?.status?.title, priority: wp._links?.priority?.title,
  }));
}

/**
 * Create a work package in OpenProject from an XMRT app.tasks row.
 * Mapping follows the task-pipeline-migration note: app.tasks is canonical.
 */
export async function opCreateWorkPackage(projectId, typeId, task) {
  const body = {
    subject: String(task.title || 'Untitled task').slice(0, 255),
    description: { format: 'markdown', raw: String(task.description || '') },
    _links: { type: { href: `/api/v3/types/${typeId}` } },
  };
  if (task.priority != null) body.priority = { href: `/api/v3/priorities/${task.priority}` };
  const data = await opFetch(`/api/v3/projects/${projectId}/work_packages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { id: data.id, subject: data.subject };
}

/**
 * Update an existing work package's status (by status id).
 */
export async function opUpdateStatus(workPackageId, statusId, lockVersion) {
  const body = { lockVersion, _links: { status: { href: `/api/v3/statuses/${statusId}` } } };
  const data = await opFetch(`/api/v3/work_packages/${workPackageId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return { id: data.id, status: data._links?.status?.title };
}

export default {
  opHealth, opListProjects, opListTypes, opListStatuses,
  opListWorkPackages, opCreateWorkPackage, opUpdateStatus,
};
