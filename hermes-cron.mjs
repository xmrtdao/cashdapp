#!/usr/bin/env node
/**
 * hermes-cron.mjs — Hermes-side inbox poller
 *
 * Runs as a background daemon. Every 10 seconds:
 *   1. Polls the relay's hermes-inbox for pending prompts
 *   2. Writes each prompt to a pending file that the Hermes agent
 *      (this CLI session) picks up via the hermes_check_prompts tool
 *   3. When the Hermes agent completes a prompt, it writes the result
 *      to the outbox, and the relay's outbox poller delivers it to fleet chat
 *
 * RELAY_DIR must point to the xmrtdao relay directory.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RELAY_DIR = process.env.RELAY_DIR || join(__dirname, '..', 'xmrtdao');
const DATA_DIR = join(RELAY_DIR, 'relay-data');
const INBOX_DIR = join(DATA_DIR, 'hermes-inbox');
const OUTBOX_DIR = join(DATA_DIR, 'hermes-outbox');
const PENDING_DIR = join(DATA_DIR, 'hermes-pending');

for (const d of [INBOX_DIR, OUTBOX_DIR, PENDING_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || '10000', 10);

function pollInbox() {
  let files;
  try {
    files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  } catch (e) {
    console.error(`[hermes-cron] Cannot read inbox: ${e.message}`);
    return;
  }

  files.sort();

  for (const file of files) {
    const filePath = join(INBOX_DIR, file);
    let entry;
    try {
      entry = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`[hermes-cron] Cannot parse ${file}: ${e.message}`);
      continue;
    }

    if (entry.status !== 'queued') continue;

    // Mark as in-progress
    entry.status = 'in_progress';
    try {
      writeFileSync(filePath, JSON.stringify(entry, null, 2));
    } catch (e) {
      console.error(`[hermes-cron] Cannot update ${file}: ${e.message}`);
      continue;
    }

    // Write to pending dir for the Hermes agent to pick up
    const pendingPath = join(PENDING_DIR, `${entry.id}.json`);
    try {
      writeFileSync(pendingPath, JSON.stringify(entry, null, 2));
      console.log(`[hermes-cron] Queued ${entry.id} for Hermes agent: "${entry.prompt.slice(0, 80)}..."`);
    } catch (e) {
      console.error(`[hermes-cron] Cannot write pending ${entry.id}: ${e.message}`);
    }
  }
}

console.log(`[hermes-cron] Starting — polling ${INBOX_DIR} every ${POLL_INTERVAL_MS}ms`);
console.log(`[hermes-cron] Pending: ${PENDING_DIR}`);
console.log(`[hermes-cron] Outbox: ${OUTBOX_DIR}`);

pollInbox();
setInterval(pollInbox, POLL_INTERVAL_MS);

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
