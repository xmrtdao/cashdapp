#!/usr/bin/env node
/**
 * start-tunnel.mjs — Permanent tunnel manager for relay.mobilemonero.com
 *
 * Uses the named Cloudflare tunnel to connect relay.mobilemonero.com
 * to localhost:8080. Updates Resend webhooks on start.
 *
 * Usage:
 *   node start-tunnel.mjs              # Normal start
 *   node start-tunnel.mjs --update-only  # Just re-point webhooks
 *   node start-tunnel.mjs --restart      # Kill existing tunnel, start fresh
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────
const CLOUDFLARED = join(__dirname, '..', 'cloudflared.exe');
const RELAY_PORT = 8080;
const CONFIG = 'C:\\Users\\PureTrek\\.cloudflared\\config.yml';
const PERMANENT_URL = 'https://relay.mobilemonero.com';

// Resend API — Three accounts (PFP + XMRT unused + 31harbor)
const RESEND_API_KEY = (() => {
  try {
    const env = readFileSync(join(__dirname, '.env'), 'utf8');
    const match = env.match(/^RESEND_API_KEY=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

const RESEND_XMRT_API_KEY = (() => {
  try {
    const env = readFileSync(join(__dirname, '.env'), 'utf8');
    const match = env.match(/^RESEND_XMRT_API_KEY=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

// NOTE: 2026-06-03 — Joe confirmed the XMRT (mobilemonero.com) Resend
// account is no longer routed through this relay. That account now
// points at Supabase (`resend-webhook-proxy` edge function) directly.
// The XMRT block was removed — if it needs to come back, recreate
// the webhook in the XMRT Resend account and re-add an entry here.
const RESEND_31HARBOR_API_KEY = (() => {
  try {
    const env = readFileSync(join(__dirname, '.env'), 'utf8');
    const match = env.match(/^RESEND_31HARBOR_API_KEY=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

const ACCOUNTS = [
  {
    label: 'PFP',
    key: RESEND_API_KEY,
    webhooks: [
      { id: 'cb2efb70-490c-42a8-bce2-352d3b801620', path: '/webhook/resend-inbound', baseUrl: PERMANENT_URL },
    ],
  },
  {
    label: '31harbor',
    key: RESEND_31HARBOR_API_KEY,
    webhooks: [
      { id: 'd443cd29-f51c-4d66-ba65-5170680c96c3', path: '/webhook/resend-inbound', baseUrl: 'https://inbox.31harbor.com' },
    ],
  },
];

const RELAY_STATE_FILE = join(__dirname, '..', 'relay-data', 'state.json');

// ── Helpers ──────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function updateResendWebhooks() {
  let success = 0;
  for (const acct of ACCOUNTS) {
    if (!acct.key) { log(`  ${acct.label}: No API key — skip`); continue; }
    for (const wh of acct.webhooks) {
      const endpoint = `${wh.baseUrl}${wh.path}`;
      try {
        const res = await fetch(`https://api.resend.com/webhooks/${wh.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${acct.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
        if (res.ok) { log(`  ${acct.label} webhook updated`); success++; }
        else { log(`  ${acct.label} webhook FAILED`); }
      } catch (err) { log(`  ${acct.label} webhook error: ${err.message}`); }
    }
  }
  return success > 0;
}

function updateRelayState() {
  try {
    const data = JSON.stringify({ value: PERMANENT_URL });
    fetch(`http://localhost:${RELAY_PORT}/state/tunnel-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
    }).then(async (res) => {
      const result = await res.json();
      if (result.success) log(`Relay state updated: tunnel-url -> ${PERMANENT_URL}`);
      else log(`Relay state update error: ${JSON.stringify(result)}`);
    }).catch(() => {
      try {
        if (existsSync(RELAY_STATE_FILE)) {
          const state = JSON.parse(readFileSync(RELAY_STATE_FILE, 'utf8'));
          state['tunnel-url'] = PERMANENT_URL;
          writeFileSync(RELAY_STATE_FILE, JSON.stringify(state, null, 2));
          log(`State file updated directly`);
        }
      } catch (e) { log(`Could not update state: ${e.message}`); }
    });
  } catch (e) { log(`Could not reach relay: ${e.message}`); }
}

function killExistingTunnel() {
  try {
    execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'ignore' });
    log('Killed existing cloudflared');
  } catch { /* none running */ }
}

function startTunnel() {
  log('Starting named tunnel for relay.mobilemonero.com...');
  const proc = spawn(CLOUDFLARED, ['tunnel', '--config', CONFIG, 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.unref();
  proc.stdout.on('data', (d) => {
    const line = d.toString();
    if (line.includes('Registered tunnel connection')) log(line.trim());
  });
  proc.stderr.on('data', (d) => {
    const line = d.toString();
    if (line.includes('Registered tunnel connection')) log(line.trim());
  });
  proc.on('error', (err) => log(`Failed to start cloudflared: ${err.message}`));
  return proc;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--update-only') ? 'update-only'
    : args.includes('--restart') ? 'restart'
    : 'start';

  log('Tunnel Manager');
  log(`URL: ${PERMANENT_URL}`);
  log(`Mode: ${mode}`);

  if (mode === 'update-only') {
    log('Updating webhooks...');
    await updateResendWebhooks();
    updateRelayState();
    log('Done');
    return;
  }

  if (mode === 'restart') {
    killExistingTunnel();
    await new Promise(r => setTimeout(r, 1000));
  }

  startTunnel();
  await new Promise(r => setTimeout(r, 3000));

  log('Updating webhooks...');
  await updateResendWebhooks();
  updateRelayState();

  log('Tunnel is live at ' + PERMANENT_URL);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
