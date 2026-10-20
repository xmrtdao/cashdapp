/**
 * Agent Bridge — file-based async agent communication.
 *
 * Agents that take minutes to complete (OpenCode, DSH) cannot be awaited
 * directly in the fleet chat router. Instead, the relay writes prompts to an
 * inbox directory and polls an outbox directory for completed results.
 *
 * Flow:
 *   1. Relay: POST /api/agent/prompt → writes {uuid}.json to agent-inbox/{agent}/
 *   2. Agent daemon: polls inbox, picks up prompt, marks in_progress, executes
 *   3. Agent daemon: writes result to agent-outbox/{agent}/{uuid}.json
 *   4. Relay: polls outbox every 5s, posts completed results to fleet chat
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const INBOX_DIR = join(ROOT, 'agent-inbox');
const OUTBOX_DIR = join(ROOT, 'agent-outbox');

// ── Queue a prompt for an agent ───────────────────────────────────────────

/**
 * Write a prompt to an agent's inbox.
 * Returns the prompt ID the agent daemon will use to track it.
 */
export function queueAgentPrompt(agent, prompt, sender = 'fleet', channel = 'fleet') {
  const inbox = join(INBOX_DIR, agent);
  mkdirSync(inbox, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    agent,
    prompt,
    sender,
    channel,
    ts: Date.now(),
    status: 'queued',
  };
  writeFileSync(join(inbox, `${id}.json`), JSON.stringify(entry, null, 2));
  return { success: true, id, message: `Prompt queued for ${agent}` };
}

// ── Poll an agent's outbox ───────────────────────────────────────────────

/**
 * Check an agent's outbox for completed results.
 * Returns an array of completed entries (and leaves files for cleanup).
 */
export function pollAgentOutbox(agent) {
  const outbox = join(OUTBOX_DIR, agent);
  if (!existsSync(outbox)) return [];
  const files = readdirSync(outbox).filter(f => f.endsWith('.json'));
  const completed = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(outbox, file), 'utf8'));
      if (entry.status === 'completed') {
        completed.push({ ...entry, _file: file });
      }
    } catch { /* skip malformed */ }
  }
  return completed;
}

/**
 * Clean up a completed outbox file.
 */
export function clearOutboxEntry(agent, file) {
  try {
    unlinkSync(join(OUTBOX_DIR, agent, file));
  } catch { /* already gone */ }
}

// ── Queue depth ──────────────────────────────────────────────────────────

/**
 * Return the number of pending prompts per agent.
 */
export function queueDepth() {
  const agents = {};
  for (const dir of readdirSync(INBOX_DIR)) {
    const inbox = join(INBOX_DIR, dir);
    try {
      const files = readdirSync(inbox).filter(f => f.endsWith('.json'));
      agents[dir] = files.length;
    } catch {
      agents[dir] = 0;
    }
  }
  return agents;
}

// ── Agent daemon base ────────────────────────────────────────────────────

/**
 * Create a polling agent daemon.
 *
 * Each daemon polls its inbox every 3 seconds, picks up the oldest queued
 * prompt, executes it with the provided handler, and writes the result to
 * the outbox.
 *
 * @param {object} opts
 * @param {string} opts.agent          Agent name (e.g., 'opencode')
 * @param {function} opts.handler       async (entry) => string  — executes the prompt
 * @param {number} [opts.pollMs]       Polling interval (default 3000)
 * @param {number} [opts.maxConcurrent] Max parallel executions (default 1)
 */
export function startAgentDaemon(opts) {
  const { agent, handler, pollMs = 3000, maxConcurrent = 1 } = opts;
  const inbox = join(INBOX_DIR, agent);
  const outbox = join(OUTBOX_DIR, agent);
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });

  let running = 0;
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      const files = readdirSync(inbox).filter(f => f.endsWith('.json'));
      if (files.length > 0 && running < maxConcurrent) {
        // Pick oldest
        files.sort();
        const file = files[0];
        const entry = JSON.parse(readFileSync(join(inbox, file), 'utf8'));
        if (entry.status === 'queued') {
          running++;
          // Mark in_progress
          entry.status = 'in_progress';
          entry.startedAt = Date.now();
          writeFileSync(join(inbox, file), JSON.stringify(entry, null, 2));

          // Execute
          (async () => {
            try {
              const result = await handler(entry);
              entry.status = 'completed';
              entry.result = result;
              entry.completedAt = Date.now();
              writeFileSync(join(outbox, file), JSON.stringify(entry, null, 2));
            } catch (e) {
              entry.status = 'completed';
              entry.result = `Error: ${e.message}`;
              entry.completedAt = Date.now();
              writeFileSync(join(outbox, file), JSON.stringify(entry, null, 2));
            } finally {
              running--;
              try { unlinkSync(join(inbox, file)); } catch { /* gone */ }
            }
          })();
        }
      }
    } catch (e) {
      console.error(`[${agent}-daemon] poll error: ${e.message}`);
    }
    if (!stopped) setTimeout(poll, pollMs);
  }

  poll();
  console.log(`[${agent}-daemon] started (poll ${pollMs}ms, max ${maxConcurrent})`);

  return {
    stop() { stopped = true; },
    get running() { return running; },
  };
}
