#!/usr/bin/env node
/**
 * deploy-cf-workers.mjs
 *
 * Deploys the local cloudflare-workers/*.js source to the matching Cloudflare
 * Workers. Each worker is treated as a module (supports `import` from sibling
 * files like _shared.mjs).
 *
 * Usage:
 *   node deploy-cf-workers.mjs                 # deploy all
 *   node deploy-cf-workers.mjs <name>          # deploy just one worker (e.g. api-gateway)
 *   node deploy-cf-workers.mjs --dry-run       # show what would happen
 *
 * Reads CF API token from cloudflare api.txt or env CF_API_TOKEN.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCfToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const tokenFile = path.join(__dirname, '..', 'cloudflare api.txt');
  if (!fs.existsSync(tokenFile)) {
    console.error('cloudflare api.txt not found at', tokenFile);
    process.exit(1);
  }
  const text = fs.readFileSync(tokenFile, 'utf8');
  // Use the mobilemonero.com token (second cfut_ in the file). It has
  // Workers Scripts:Edit, Access: Apps:Edit, DNS:Edit, etc.
  const allCfut = text.match(/cfut_[A-Za-z0-9]+/g) || [];
  if (allCfut.length === 0) {
    console.error('Could not find cfut_ token in cloudflare api.txt');
    process.exit(1);
  }
  // Prefer the last cfut_ token (the one after the MOBILMONERO.COM header)
  return allCfut[allCfut.length - 1];
}

const CF = process.env.CF_API_TOKEN || loadCfToken();
const ACC = process.env.CF_ACCOUNT_ID || 'ef8e3637c4a00a43860b679ecd138a05';
const ZONE = process.env.CF_ZONE_ID || '8710927c035b113b585b1d09403f7034';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetWorker = args.find(a => !a.startsWith('--'));

// Module workers: { name, entryFile, siblingFiles, routes }
const WORKERS = [
  {
    name: 'api-gateway',
    entryFile: 'api-gateway.js',
    siblings: ['_shared.mjs'],
    routes: ['api.mobilemonero.com/*', 'relay.mobilemonero.com/*'],
  },
  {
    name: 'dashboard',
    entryFile: 'dashboard.js',
    siblings: ['_shared.mjs'],
    routes: ['dashboard.mobilemonero.com/*'],
  },
  {
    name: '1d-price-ticker',
    entryFile: 'price-ticker.js',
    siblings: ['_shared.mjs'],
    routes: ['price.mobilemonero.com/*'],
  },
  {
    name: 'fleet-status',
    entryFile: 'fleet-status.js',
    siblings: ['_shared.mjs'],
    routes: ['fleet.mobilemonero.com/*'],
  },
  {
    name: 'hermes',
    entryFile: 'hermes.js',
    siblings: ['_shared.mjs'],
    routes: ['hermes.mobilemonero.com/*'],
  },
  {
    name: 'inbox',
    entryFile: 'inbox.js',
    siblings: ['_shared.mjs'],
    routes: ['inbox.mobilemonero.com/*'],
  },
  {
    name: 'mtv-lyrics',
    entryFile: 'mtv-lyrics.js',
    siblings: ['_shared.mjs'],
    routes: ['mtv-lyrics.mobilemonero.com/*', 'mtv.mobilemonero.com/*'],
  },
];

async function cf(method, url, body) {
  const headers = { Authorization: 'Bearer ' + CF };
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const opts = { method, headers };
  if (body) opts.body = body;
  const r = await fetch('https://api.cloudflare.com/client/v4' + url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    console.error('CF API error', method, url, ':', r.status);
    if (typeof data === 'object') console.error(JSON.stringify(data, null, 2).slice(0, 1500));
    else console.error(String(data).slice(0, 1500));
    throw new Error('CF API ' + r.status);
  }
  return data;
}

// Module-style worker deploy
async function deployModuleWorker(name, entryFile, siblingFiles) {
  const entryPath = path.join(__dirname, entryFile);
  if (!fs.existsSync(entryPath)) {
    console.error('  ! entry file not found:', entryPath);
    return false;
  }
  const entryCode = fs.readFileSync(entryPath, 'utf8');
  if (dryRun) {
    console.log('  [dry-run] would deploy', name, '(' + entryCode.length + ' bytes main + ' + siblingFiles.length + ' siblings)');
    return true;
  }

  const boundary = '----v' + Math.random().toString(36).slice(2, 12);
  const parts = [];
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="metadata"\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01', compatibility_flags: [] }) + '\r\n'
  ));
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n' +
    'Content-Type: application/javascript+module\r\n\r\n' +
    entryCode + '\r\n'
  ));
  for (const sf of siblingFiles) {
    const sp = path.join(__dirname, sf);
    if (!fs.existsSync(sp)) { console.error('  ! sibling file not found:', sp); return false; }
    const sc = fs.readFileSync(sp, 'utf8');
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + sf + '"; filename="' + sf + '"\r\n' +
      'Content-Type: application/javascript+module\r\n\r\n' +
      sc + '\r\n'
    ));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);

  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + ACC + '/workers/scripts/' + name, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + CF, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  const data = await r.json();
  if (!r.ok || !data.success) {
    console.error('  ! deploy failed:', JSON.stringify(data, null, 2).slice(0, 2000));
    return false;
  }
  console.log('  [ok] deployed', name, 'etag=' + (data.result && data.result.etag || '').slice(0, 8));
  return true;
}

async function setRoutes(name, patterns) {
  const existing = await cf('GET', '/zones/' + ZONE + '/workers/routes?script_name=' + name);
  const existingPatterns = (existing.result || []).map(r => r.pattern);
  for (const p of patterns) {
    if (existingPatterns.includes(p)) { console.log('  [skip route]', p, '(exists)'); continue; }
    if (dryRun) { console.log('  [dry-run route]', p); continue; }
    try {
      await cf('POST', '/zones/' + ZONE + '/workers/routes', { pattern: p, script: name });
      console.log('  [ok route]', p);
    } catch (e) {
      console.log('  [route err]', p, e.message);
    }
  }
}

async function main() {
  console.log('CF token:', CF.slice(0, 12) + '...');
  console.log('Account:', ACC);
  console.log('Zone:', ZONE);
  console.log('Mode:', dryRun ? 'DRY-RUN' : 'deploy');
  console.log('');

  const toDeploy = targetWorker ? WORKERS.filter(w => w.name === targetWorker) : WORKERS;
  if (targetWorker && toDeploy.length === 0) {
    console.error('No worker named', targetWorker, 'found in config');
    process.exit(1);
  }

  for (const w of toDeploy) {
    console.log('---', w.name, '(' + w.routes.join(', ') + ') ---');
    const ok = await deployModuleWorker(w.name, w.entryFile, w.siblings);
    if (!ok) continue;
    if (!dryRun) await setRoutes(w.name, w.routes);
  }

  console.log('');
  console.log('Done.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
