#!/usr/bin/env node
/**
 * reconcile-supervisor-state.mjs — one-shot cleanup of relay-data/supervisor-state.json
 *
 * - Removes service entries that no longer exist in supervisor.mjs SERVICES array
 * - Nullifies childPid entries that point at dead PIDs
 *
 * Safe to run multiple times. Idempotent.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'relay-data', 'supervisor-state.json');

// Mirror the SERVICES array in supervisor.mjs
const SERVICES = [
  'relay', 'campaign-scheduler', 'pg', 'local-sb', 'vite', 'tunnel', 'alice', 'cron-engine-v2',
];

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    const out = execSync(
      `powershell.exe -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`,
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    ).trim();
    return out.length > 0 && /^\d+$/.test(out);
  } catch { return false; }
}

if (!existsSync(STATE_FILE)) {
  console.error(`No state file at ${STATE_FILE} — nothing to reconcile`);
  process.exit(0);
}

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
let touched = 0;

// 1. Prune legacy services
if (state.services) {
  for (const k of Object.keys(state.services)) {
    if (!SERVICES.includes(k)) {
      console.log(`  [PRUNE] legacy service: ${k}`);
      delete state.services[k];
      touched++;
    }
  }

  // 2. Reconcile dead PIDs
  for (const svc of SERVICES) {
    const entry = state.services[svc];
    if (entry && entry.childPid && !pidAlive(entry.childPid)) {
      console.log(`  [PID-DEAD] ${svc}: childPid ${entry.childPid} -> null`);
      entry.childPid = null;
      touched++;
    }
  }
}

if (touched > 0) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\nReconciled ${touched} entries. State file updated.`);
} else {
  console.log('No reconciliations needed.');
}
