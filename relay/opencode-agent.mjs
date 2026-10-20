#!/usr/bin/env node
/**
 * OpenCode Agent Daemon
 *
 * Polls agent-inbox/opencode/ for queued prompts, executes them with the
 * OpenCode server, and writes results to agent-outbox/opencode/.
 *
 * WHY IT USES HTTP AND NOT THE CLI
 * --------------------------------
 * This used to spawn `opencode run --model <model> --auto --format json`.
 * That never answered: the CLI starts its own background service, the server
 * the fleet actually runs is a different one, and the two disagreed about the
 * password - so the CLI either refused the connection or waited on a service
 * that was not the one doing the work.
 *
 * The server is reachable over HTTP, and the loopback proxy injects its
 * credential, so this path carries no secret and cannot drift out of step
 * with the server the way a second, separately-authenticated client did.
 *
 * The proxy is the same one the operator's dashboard opencode button points
 * at, so the fleet and the operator use one harness and one way in.
 */

import { startAgentDaemon } from './lib/agent-bridge.mjs';
import { join } from 'path';
import http from 'http';

// The loopback proxy. It injects the server's credential for requests that
// arrive without one, so nothing here has to know a password.
const BASE = (process.env.OPENCODE_PROXY_URL || 'http://127.0.0.1:4130').replace(/\/$/, '');

// Left empty on purpose: the server picks the model, and what it picks
// (ollama-cloud/minimax-m3.1-flash) is free and answers in seconds. Forcing
// opencode-go's slug here asks for a subscription this account does not have,
// and the worker comes back empty.
const MODEL = process.env.OPENCODE_AGENT_MODEL || '';

const MAX_WAIT_MS = Number(process.env.OPENCODE_AGENT_TIMEOUT_MS || 5 * 60 * 1000);

// A health endpoint, so the supervisor can tell "running" from "running and
// broken". A daemon with no way to be checked is a daemon that is either
// restarted for no reason or left broken for no reason.
const HEALTH_PORT = Number(process.env.OPENCODE_AGENT_PORT || 9335);

let inFlight = 0;
let lastPromptAt = null;
let lastError = null;

async function api(method, path, body, timeoutMs = 120000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const txt = await r.text();
    if (!r.ok) return null;
    try { return JSON.parse(txt); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function executePrompt(entry) {
  const prompt = entry.prompt;
  console.log(`[opencode-agent] executing prompt ${entry.id} (${prompt.length} chars)`);
  inFlight++;
  lastPromptAt = new Date().toISOString();
  lastError = null;
  try {
    return await runPrompt(prompt);
  } catch (e) {
    lastError = e?.message || String(e);
    throw e;
  } finally {
    inFlight--;
  }
}

async function runPrompt(prompt) {
  const created = await api('POST', '/api/session', { title: String(prompt).slice(0, 80) });
  const sessionId = created?.data?.id;
  if (!sessionId) {
    throw new Error(`could not create a session on ${BASE} (the OpenCode server may be down)`);
  }

  const sent = await api('POST', `/api/session/${sessionId}/prompt`, {
    text: prompt,
    ...(MODEL ? { model: { providerID: 'opencode', modelID: MODEL } } : {}),
    agent: 'build',
  });
  if (!sent) throw new Error('the OpenCode server did not accept the prompt');

  // The server answers in the background, so the reply is polled for. A
  // message that has not finished streaming has only the model's reasoning in
  // it, and reading it early is how a finished piece of work was once
  // recorded as "the worker replied with nothing".
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const msgs = await api('GET', `/api/session/${sessionId}/message`);
    const arr = Array.isArray(msgs?.data) ? msgs.data : [];
    const assistant = arr.filter((m) => m.type === 'assistant').pop();
    if (assistant) {
      if (assistant.finish === 'error' || assistant.error) {
        throw new Error(`worker failed: ${JSON.stringify(assistant.error).slice(0, 300)}`);
      }
      if (assistant.time?.completed === undefined && assistant.finish === undefined) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const parts = Array.isArray(assistant.content) ? assistant.content : [];
      const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
      const tools = [...new Set(parts
        .filter((c) => c.type === 'tool' || c.tool || c.name)
        .map((c) => c.name || c.tool || (c.state && c.state.title) || 'tool'))];
      const out = [text, tools.length ? `Tools used: ${tools.join('; ')}` : '']
        .filter(Boolean).join('\n').trim();
      if (!out) throw new Error('the worker replied with nothing');
      return out;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`the worker did not answer within ${Math.round(MAX_WAIT_MS / 1000)}s`);
}

startAgentDaemon({
  agent: 'opencode',
  handler: executePrompt,
  pollMs: 3000,
  maxConcurrent: 1,
});

// The health endpoint. Loopback only, like the other control surfaces.
http.createServer((req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({
      ok: true,
      agent: 'opencode',
      base: BASE,
      inFlight,
      lastPromptAt,
      lastError,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[opencode-agent] health on http://127.0.0.1:${HEALTH_PORT}/health`);
});
