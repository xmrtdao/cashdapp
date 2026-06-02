#!/usr/bin/env node
/**
 * update-access-policies.mjs
 *
 * Adds a "Browser bypass -> allow through to worker (worker enforces JWT)"
 * policy to each dashboard Access app so browser requests reach the worker.
 * The worker code itself does the XMRT University cert validation.
 *
 * Worker-to-worker service token auth continues to work via the existing
 * "Agents Only" policies (precedence 1).
 *
 * Usage: node update-access-policies.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCfToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const tokenFile = path.join(__dirname, '..', 'cloudflare api.txt');
  const text = fs.readFileSync(tokenFile, 'utf8');
  const all = text.match(/cfut_[A-Za-z0-9]+/g) || [];
  return all[all.length - 1];
}

const CF = process.env.CF_API_TOKEN || loadCfToken();
const ZONE = process.env.CF_ZONE_ID || '8710927c035b113b585b1d09403f7034';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// Subdomains that should be browser-accessible (worker enforces JWT)
const APP_IDS = {
  'api.mobilemonero.com':     '502b902e-c3e3-4872-b0d2-9c1db75f0847',
  'dashboard.mobilemonero.com': 'd6f20848-63dc-4b64-b9b5-d49ad02f356f',
  'price.mobilemonero.com':   '1f0a7919-f738-48cb-9bfc-f830f2465192',
  'fleet.mobilemonero.com':   'a4a28ecb-c4f7-4aa5-85d5-81fb805451e5',
  'hermes.mobilemonero.com':  '1936e70d-6f16-4402-83c5-a7896c7203f8',
  'inbox.mobilemonero.com':   'c326e987-d835-436b-801e-e3ff825110be',
  'mtv.mobilemonero.com':     '5f59518b-5487-4e53-84a0-e927a7db9ed0',
};

const BYPASS_POLICY = {
  name: 'Browser Bypass (worker enforces JWT)',
  decision: 'bypass',
  precedence: 99,
  include: [
    { everyone: {} }
  ],
};

async function cf(method, url, body) {
  const headers = { Authorization: 'Bearer ' + CF };
  if (body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch('https://api.cloudflare.com/client/v4' + url, { method, headers, body });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    console.error('CF API', method, url, ':', r.status);
    if (typeof data === 'object') console.error(JSON.stringify(data, null, 2).slice(0, 1500));
    else console.error(String(data).slice(0, 1500));
    throw new Error('CF ' + r.status);
  }
  return data;
}

async function updateApp(domain, appId) {
  console.log('---', domain, '(', appId, ') ---');
  const app = await cf('GET', '/zones/' + ZONE + '/access/apps/' + appId);
  const a = app.result;
  if (!a) { console.log('  ! app not found'); return false; }
  const existingPolicies = a.policies || [];
  // Check if the bypass policy already exists
  if (existingPolicies.some(p => p.name === BYPASS_POLICY.name)) {
    console.log('  [skip] bypass policy already exists');
    return true;
  }
  const newPolicies = [...existingPolicies, BYPASS_POLICY];
  if (dryRun) {
    console.log('  [dry-run] would add bypass policy. new policy count:', newPolicies.length);
    return true;
  }
  // Update the app
  const updated = Object.assign({}, a, { policies: newPolicies });
  // Strip fields that PUT doesn't accept
  delete updated.id;
  delete updated.created_at;
  delete updated.updated_at;
  try {
    await cf('PUT', '/zones/' + ZONE + '/access/apps/' + appId, updated);
    console.log('  [ok] added bypass policy');
    return true;
  } catch (e) {
    console.log('  [err]', e.message);
    return false;
  }
}

async function main() {
  console.log('CF token:', CF.slice(0, 12) + '...');
  console.log('Zone:', ZONE);
  console.log('Mode:', dryRun ? 'DRY-RUN' : 'update');
  console.log('');

  let ok = 0, fail = 0;
  for (const [domain, appId] of Object.entries(APP_IDS)) {
    if (await updateApp(domain, appId)) ok++; else fail++;
  }
  console.log('');
  console.log('Done. ok=' + ok + ' fail=' + fail);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
