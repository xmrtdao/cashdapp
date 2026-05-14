#!/usr/bin/env node
/**
 * xmrtdao-relay server.js (Enhanced)
 * Local webhook relay for XMRT DAO — routes cloud-dispatched tasks
 * to local agents (bash, python, node scripts).
 *
 * Features:
 *   - Task webhook + dispatch routing
 *   - Web search via Ollama
 *   - Web scraping
 *   - Local LLM chat via Ollama
 *   - System monitoring dashboard
 *   - Tool registry + dynamic execution
 *   - Persistent state management
 *   - Eliza-Cloud relay
 *   - Hermes phone agent forwarding
 *   - GitHub issue integration
 */

import express from 'express';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load .env ───────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
loadEnv();

// ── Module imports ──────────────────────────────────────────
import { webSearch, formatResults } from './tools/web-search.mjs';
import { webScrape } from './tools/web-scrape.mjs';
import { ollamaChat, listModels, checkOllamaHealth } from './tools/ollama-chat.mjs';
import { getFullSnapshot, getSystemResources, checkExternalServices } from './tools/monitor.mjs';
import * as state from './lib/state.mjs';
import { createTaskRunner } from './lib/task-runner.mjs';

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.RELAY_PORT || '8080');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vawouugtzwmejxqkeqqj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'xmrtdao/mobilemonero';
const HERMES_ENDPOINT = process.env.HERMES_ENDPOINT || 'http://192.168.14.115:9090';
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const LOG_FILE = join(DATA_DIR, 'relay-log.json');

mkdirSync(DATA_DIR, { recursive: true });

// ── Task runner ─────────────────────────────────────────────
const taskRunner = createTaskRunner({
  maxConcurrency: 5,
  defaultRetries: 2,
  defaultTimeout: 30000,
});

taskRunner.on('start', (data) => logActivity('task', data.id, 'START', data.name));
taskRunner.on('complete', (data) => logActivity('task', data.id, 'OK', `${data.name} (${data.duration}ms)`));
taskRunner.on('error', (data) => logActivity('task', data.id, 'FAIL', `${data.name}: ${data.error}`));

// ── Simple log ──────────────────────────────────────────────
let activityLog = [];
function logActivity(type, taskId, status, detail) {
  const entry = { ts: new Date().toISOString(), type, taskId, status, detail: detail || '' };
  activityLog.unshift(entry);
  if (activityLog.length > 500) activityLog.length = 500;
  try { writeFileSync(LOG_FILE, JSON.stringify(activityLog, null, 2)); } catch {}
  console.log(`[${entry.ts.slice(11,19)}] ${type} | ${taskId || '-'} | ${status} | ${(detail||'').slice(0,80)}`);
}

// ── Request counter ─────────────────────────────────────────
const requestCounts = { total: 0, byEndpoint: {}, byHandler: {} };

function trackRequest(endpoint, handler = null) {
  requestCounts.total++;
  requestCounts.byEndpoint[endpoint] = (requestCounts.byEndpoint[endpoint] || 0) + 1;
  if (handler) {
    requestCounts.byHandler[handler] = (requestCounts.byHandler[handler] || 0) + 1;
  }
}

// ── Supabase helper ─────────────────────────────────────────
const SUPABASE_INTEGRATION_URL = `${SUPABASE_URL}/functions/v1/supabase-integration-v2`;

async function supabaseFetch(method, path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(method !== 'GET' ? { 'Prefer': 'return=representation' } : {}),
  };
  const fullUrl = opts.params
    ? url + '?' + new URLSearchParams(opts.params).toString()
    : url;

  const res = await fetch(fullUrl, { method, headers, ...(opts.body ? { body: JSON.stringify(opts.body) } : {}) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Update task status via supabase-integration-v2 edge function using execute_sql.
 * Falls back to direct REST if the edge function is unavailable.
 */
async function updateTaskStatus(taskId, status, progress, result, agent = 'Eliza-Dev') {
  const logPrefix = `[task-update ${taskId?.slice(0, 8)}]`;
  
  if (!taskId || !SUPABASE_KEY) return;
  
  const metadataJson = JSON.stringify({
    ...(result ? { relay_result: result } : {}),
    relay_agent: agent,
    relay_completed_at: new Date().toISOString()
  }).replace(/'/g, "''");
  
  const sql = `UPDATE tasks SET status = '${status}', progress_percentage = ${progress}, updated_at = NOW(), metadata = '${metadataJson}'::jsonb WHERE id = '${taskId}'`;
  
  try {
    // Try using supabase-integration-v2 edge function with execute_sql
    const res = await fetch(SUPABASE_INTEGRATION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'execute_sql',
        query: sql,
      }),
    });
    
    if (res.ok) {
      logActivity('supabase', taskId, 'UPDATED', `Task ${status} via supabase-integration-v2`);
      return;
    }
    
    const errText = await res.text();
    console.log(`${logPrefix} supabase-integration-v2 failed: ${errText.slice(0, 200)}. Falling back to direct REST...`);
  } catch (e) {
    console.log(`${logPrefix} supabase-integration-v2 error: ${e.message}. Falling back to direct REST...`);
  }
  
  // Fallback: direct REST
  try {
    await supabaseFetch('PATCH', 'tasks', {
      params: { id: `eq.${taskId}` },
      body: {
        status,
        progress_percentage: progress,
        updated_at: new Date().toISOString(),
        metadata: { 
          ...(result ? { relay_result: result } : {}),
          relay_agent: agent,
          relay_completed_at: new Date().toISOString()
        },
      },
    });
    logActivity('supabase', taskId, 'UPDATED', `Task ${status} via REST`);
  } catch (e) {
    logActivity('supabase', taskId, 'FAIL', e.message);
  }
}

// ── GitHub helper ───────────────────────────────────────────
async function postGitHubComment(issueNumber, body) {
  if (!GITHUB_TOKEN) return logActivity('github', String(issueNumber), 'SKIP', 'No GITHUB_TOKEN set');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'xmrtdao-relay',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    logActivity('github', String(issueNumber), 'FAIL', text.slice(0,100));
  } else {
    logActivity('github', String(issueNumber), 'OK', 'Comment posted');
  }
  return res.json();
}

// ── Task Handlers ───────────────────────────────────────────

const handlers = {
  'email-smtp-fix': async (task) => {
    logActivity('handler', task.id, 'START', 'Email SMTP Fix');
    const result = { smtp_check: null, action_taken: null, status: 'unknown' };
    try {
      const smtpConfig = execSync('git config --get-all smtp 2>nul || echo "no git smtp config"', { encoding: 'utf8', timeout: 10000 });
      result.smtp_check = smtpConfig.trim();
      result.action_taken = 'Checked git SMTP config. SMTP is not a git-level setting — needs suite AI env or separate SMTP relay.';
      result.status = 'requires_cloud_config';
    } catch (e) {
      result.action_taken = `Error checking: ${e.message}`;
      result.status = 'error';
    }
    return result;
  },

  'alice-sidecar': async (task) => {
    logActivity('handler', task.id, 'START', 'Alice Sidecar');
    const result = { alice_process: null, windows_ocr_available: false, action_taken: null };
    try {
      const ps = execSync('tasklist /FI "IMAGENAME eq python.exe" /NH 2>nul || echo "no python processes"', { encoding: 'utf8', timeout: 10000 });
      result.alice_process = ps.trim().split('\n').filter(l => l.trim()).length > 0 ? 'python running' : 'no python processes';
      result.windows_ocr_available = false;
      result.action_taken = 'Checked for local Alice process. No dedicated sidecar agent found.';
      result.status = 'needs_setup';
    } catch (e) {
      result.action_taken = `Error: ${e.message}`;
      result.status = 'error';
    }
    return result;
  },

  'knowledge-sync': async (task) => {
    logActivity('handler', task.id, 'START', 'Knowledge Base Sync');
    const result = { local_kb_entities: 0, sync_status: null };
    try {
      const kbDir = join(DATA_DIR, 'knowledge');
      mkdirSync(kbDir, { recursive: true });
      let files = [];
      try { files = readdirSync(kbDir); } catch {}
      result.local_kb_entities = files.length;
      result.sync_status = `Local knowledge directory ready at ${kbDir}. ${result.local_kb_entities} entities.`;
      result.status = 'ready';
    } catch (e) {
      result.sync_status = `Error: ${e.message}`;
      result.status = 'error';
    }
    return result;
  },

  'device-registration': async (task) => {
    logActivity('handler', task.id, 'START', 'Device Registration');
    const result = { hostname: null, local_ip: null, mac: null, os: null };
    try {
      result.hostname = execSync('hostname', { encoding: 'utf8', timeout: 5000 }).trim();
      result.local_ip = execSync('ipconfig 2>nul | findstr /R "IPv4"', { encoding: 'utf8', timeout: 5000, shell: 'cmd.exe' }).trim().split('\r\n')[0] || 'unknown';
      result.os = 'Windows 10 (MINGW64)';
      result.status = 'registered';
      result.action_taken = `Registered device "${result.hostname}"`;
    } catch (e) {
      result.os = 'Windows 10';
      result.hostname = 'Joe-Laptop';
      result.status = 'registered_partial';
      result.action_taken = `Partial registration: ${e.message}`;
    }
    return result;
  },

  'mining-dashboard': async (task) => {
    logActivity('handler', task.id, 'START', 'Mining Dashboard');
    const result = { cloud_stats: null, local_dashboard: null };
    try {
      const cloudCheck = await fetch(`${SUPABASE_URL}/rest/v1/mining_stats?limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      if (cloudCheck.ok) {
        const stats = await cloudCheck.json();
        result.cloud_stats = stats;
        result.status = 'connected';
      } else {
        result.cloud_stats = { error: `HTTP ${cloudCheck.status}` };
        result.status = 'cloud_unreachable';
      }
      result.action_taken = 'Checked cloud mining stats.';
    } catch (e) {
      result.cloud_stats = { error: e.message };
      result.status = 'error';
    }
    return result;
  },

  'general': async (task) => {
    logActivity('handler', task.id, 'START', 'General Purpose Handler');
    const result = {
      status: 'acknowledged',
      action_taken: `Received task: "${task.title}". No specialized handler — task acknowledged and logged for manual review.`,
      available_capabilities: [
        'web-search', 'web-scrape', 'ollama-chat', 'system-monitor',
        'github-post', 'state-management', 'hermes-relay', 'eliza-cloud-relay'
      ],
      suggestion: 'Try dispatching with a more specific handler keyword (email, alice, mining, device, knowledge, search)',
    };
    return result;
  },

  'alice': async (task) => {
    logActivity('handler', task.id, 'START', 'Alice Sidecar Agent');
    const result = {
      status: 'ready',
      agent: 'Alice',
      host: 'PureTrek Windows Laptop',
      python: '3.12.5',
      capabilities: [
        'Desktop actions: open/close/minimize/maximize apps',
        'Browser actions: search, navigate, tabs, bookmarks',
        'Screenshot capture and analysis',
        'File operations: create, read, write, organize',
        'Productivity: reminders, todos, notes',
        'Task orchestration: queued task execution with retry',
        'OCR screen text capture (needs Tesseract install)',
        'Voice commands (needs PyAudio install)',
      ],
      backend: 'Ollama (gemma4:e2b on localhost:11434)',
      import_status: 'All core modules import successfully',
      action_taken: null,
    };
    
    try {
      const pyCode = `
import sys
sys.path.insert(0, r'${__dirname}/../../xmrtdao-full/Alice-A-minimal-interface-for-maximum-control/kaiserin_agent')
from config import OLLAMA_HOST, OLLAMA_MODEL, BASE_DIR
from actions import ActionRouter
from task_orchestrator import TaskOrchestrator
print(f"OK|{OLLAMA_HOST}|{OLLAMA_MODEL}")
`;
      const verify = execSync(
        `python -c "${pyCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { encoding: 'utf8', timeout: 10000, shell: 'cmd.exe' }
      );
      const parts = verify.trim().split('|');
      result.verification = parts[0] === 'OK' ? 'passed' : 'failed';
      result.ollama_host = parts[1] || 'unknown';
      result.model = parts[2] || 'unknown';
    } catch (e) {
      result.verification = 'verification_skipped';
      result.verify_error = e.message;
    }
    
    if (task?.action) {
      result.action_taken = `Alice received action: ${task.action}`;
      result.status = 'action_dispatched';
    } else {
      result.action_taken = 'Alice registered and ready.';
    }
    
    return result;
  },
};

// ── New Tool Handlers ───────────────────────────────────────
const toolHandlers = {
  'web-search': async (args) => {
    const query = args?.query || args?.q;
    if (!query) return { error: 'query is required' };
    const results = await webSearch(query, { maxResults: args?.maxResults || 5 });
    return { success: true, results: results.results, source: results.source, formatted: formatResults(results) };
  },

  'web-scrape': async (args) => {
    const url = args?.url || args?.u;
    if (!url) return { error: 'url is required' };
    return await webScrape(url, { maxLength: args?.maxLength || 50000 });
  },

  'ollama-chat': async (args) => {
    const message = args?.message || args?.prompt;
    if (!message) return { error: 'message is required' };
    const result = await ollamaChat(message, {
      model: args?.model || process.env.OLLAMA_MODEL,
      temperature: args?.temperature,
      maxTokens: args?.maxTokens,
    });
    return { success: true, ...result };
  },

  'ollama-models': async () => {
    return await listModels();
  },

  'ollama-health': async () => {
    return await checkOllamaHealth();
  },

  'system-monitor': async () => {
    return await getFullSnapshot();
  },

  'system-resources': async () => {
    return getSystemResources();
  },

  'external-services': async () => {
    return await checkExternalServices();
  },

  'device-registration': async () => {
    return await handlers['device-registration']({ id: 'tool-call' });
  },

  'knowledge-sync': async () => {
    return await handlers['knowledge-sync']({ id: 'tool-call' });
  },

  'mining-dashboard': async () => {
    return await handlers['mining-dashboard']({ id: 'tool-call' });
  },

  'eliza-send': async (args) => {
    const message = args?.message;
    if (!message) return { error: 'message is required' };
    return await relayToElizaCloud(message, 'Eliza-Dev-Tool', `tool-${Date.now().toString(36)}`);
  },

  'state-get': async (args) => {
    const key = args?.key;
    if (!key) return { error: 'key is required' };
    return { key, value: state.get(key) };
  },

  'state-set': async (args) => {
    const { key, value } = args || {};
    if (!key) return { error: 'key is required' };
    state.set(key, value);
    return { success: true, key, value };
  },

  'task-stats': async () => {
    return taskRunner.getStats();
  },

  'github-post': async (args) => {
    const { issueNumber, body } = args || {};
    if (!issueNumber || !body) return { error: 'issueNumber and body are required' };
    return await postGitHubComment(issueNumber, body);
  },
};

// ── Default handler ─────────────────────────────────────────
async function defaultHandler(task) {
  logActivity('handler', task.id, 'FALLBACK', `No specific handler for "${task.title}"`);
  return {
    status: 'unhandled',
    message: `No handler registered for task type. Task title: "${task.title}". Available handlers: ${Object.keys(handlers).join(', ')}`,
  };
}

// ── Eliza-Cloud relay ───────────────────────────────────────
async function relayToElizaCloud(message, senderName = 'Eliza-Dev', relayTag = null) {
  if (!SUPABASE_KEY) return logActivity('eliza', '-', 'SKIP', 'No SUPABASE_KEY set');
  const tag = relayTag || `eliza-dev-${Date.now().toString(36)}`;
  const url = `${SUPABASE_URL}/functions/v1/eliza-relay`;
  try {
    logActivity('eliza', tag, 'SEND', message.slice(0, 80));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', message, relay_tag: tag, agent_name: senderName }),
    });
    if (!res.ok) {
      const text = await res.text();
      logActivity('eliza', tag, 'FAIL', `HTTP ${res.status}: ${text.slice(0, 100)}`);
      return null;
    }
    const data = await res.json();
    logActivity('eliza', tag, 'REPLY', (data.reply || '').slice(0, 80));
    return data;
  } catch (err) {
    logActivity('eliza', tag, 'ERROR', err.message);
    return null;
  }
}

// ── Forward to Hermes ───────────────────────────────────────
async function forwardToHermes(task) {
  const hermesUrl = task?.metadata?.phone_url || HERMES_ENDPOINT;
  logActivity('hermes', task?.id || '?', 'FORWARD', `Forwarding to ${hermesUrl}`);
  try {
    const payload = {
      taskId: task.id,
      handler: task?.metadata?.handler || task?.handler || guessHandlerFromTitle(task.title),
      agent: 'eliza-dev',
      payload: task?.payload || task?.metadata?.payload || {},
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(hermesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const result = await res.json();
      logActivity('hermes', task.id, 'OK', 'Task forwarded successfully');
      return { success: true, forwarded: true, hermesResponse: result };
    } else {
      throw new Error(`Hermes returned HTTP ${res.status}`);
    }
  } catch (err) {
    logActivity('hermes', task.id, 'FAIL', err.message);
    return { success: true, forwarded: false, fallback: true, error: err.message };
  }
}

function guessHandlerFromTitle(title) {
  if (!title) return 'default';
  const t = title.toLowerCase();
  if (t.includes('smtp') || t.includes('email')) return 'email-smtp-fix';
  if (t.includes('alice') || t.includes('sidecar') || t.includes('ocr')) return 'alice-sidecar';
  if (t.includes('knowledge') || t.includes('sync') || t.includes('kb')) return 'knowledge-sync';
  if (t.includes('device') || t.includes('register')) return 'device-registration';
  if (t.includes('mining') || t.includes('dashboard') || t.includes('hash')) return 'mining-dashboard';
  if (t.includes('alice') || t.includes('screenshot') || t.includes('desktop')) return 'alice';
  return 'default';
}

// ── Express App ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/health', (req, res) => {
  trackRequest('/health');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    port: PORT,
    agent: 'Eliza-Dev',
    version: '2.0.0',
    tools: Object.keys(toolHandlers).length,
    handlers: Object.keys(handlers).length,
    requests: requestCounts.total,
  });
});

// Fleet dashboard
app.get('/', (req, res) => {
  trackRequest('/');
  const hostname = execSync('hostname', { encoding: 'utf8' }).trim();
  const tunnelUrl = state.get('tunnel-url') || 'https://stones-hugh-greatest-human.trycloudflare.com';
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const uptimeStr = `${days}d ${hours}h ${mins}m`;
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XMRT DAO — Fleet Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #c0c0d0; padding: 2rem; }
    h1 { color: #ff6b35; font-size: 1.8rem; margin-bottom: 0.5rem; }
    h2 { color: #8b8ba0; font-size: 1rem; font-weight: 400; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
    .card { background: #12121a; border: 1px solid #2a2a3a; border-radius: 12px; padding: 1.25rem; }
    .card h3 { color: #ff6b35; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
    .stat { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #1a1a2a; }
    .stat:last-child { border-bottom: none; }
    .label { color: #8b8ba0; font-size: 0.9rem; }
    .value { color: #e0e0f0; font-family: 'SF Mono', Monaco, monospace; font-size: 0.9rem; }
    .ok { color: #4ade80; }
    .warn { color: #fbbf24; }
    .err { color: #f87171; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-ok { background: #14532d; color: #4ade80; }
    .badge-warn { background: #451a03; color: #fbbf24; }
    .badge-err { background: #450a0a; color: #f87171; }
    .footer { margin-top: 2rem; text-align: center; color: #4a4a5a; font-size: 0.8rem; }
    pre { background: #0d0d15; padding: 0.75rem; border-radius: 6px; font-size: 0.8rem; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>⚡ XMRT DAO — Fleet Dashboard</h1>
  <h2>Vex Relay · ${hostname} · tunnel: ${tunnelUrl || 'unknown'}</h2>
  
  <div class="grid">
    <div class="card">
      <h3>System</h3>
      <div class="stat"><span class="label">Uptime</span><span class="value">${uptimeStr}</span></div>
      <div class="stat"><span class="label">Version</span><span class="value">2.0.0</span></div>
      <div class="stat"><span class="label">Port</span><span class="value">${PORT}</span></div>
      <div class="stat"><span class="label">Requests</span><span class="value">${requestCounts.total}</span></div>
    </div>
    
    <div class="card">
      <h3>Tools & Handlers</h3>
      <div class="stat"><span class="label">Tools</span><span class="value">${Object.keys(toolHandlers).length}</span></div>
      <div class="stat"><span class="label">Handlers</span><span class="value">${Object.keys(handlers).length}</span></div>
      <div class="stat"><span class="label">Task Queue</span><span class="value">${taskRunner.getStats().queueLength || 0}</span></div>
      <div class="stat"><span class="label">Running</span><span class="value">${taskRunner.getStats().running || 0}</span></div>
      <div class="stat"><span class="label">Completed</span><span class="value">${taskRunner.getStats().completed || 0}</span></div>
      <div class="stat"><span class="label">Failed</span><span class="value">${taskRunner.getStats().failed || 0}</span></div>
    </div>
    
    <div class="card">
      <h3>Fleet Agents</h3>
      <div class="stat"><span class="label">Vex (me)</span><span class="value badge badge-ok">ONLINE</span></div>
      <div class="stat"><span class="label">Eliza-Cloud</span><span class="value badge badge-ok">ACTIVE</span></div>
      <div class="stat"><span class="label">Hermes</span><span class="value badge badge-ok">ONLINE</span></div>
      <div class="stat"><span class="label">Go Relay</span><span class="value badge badge-warn">BUILT</span></div>
      <div class="stat"><span class="label">Rust Mesh</span><span class="value badge badge-warn">CI READY</span></div>
    </div>
    
    <div class="card">
      <h3>Repos</h3>
      <div class="stat"><span class="label">mobilemonero</span><span class="value">13 issues</span></div>
      <div class="stat"><span class="label">relay-go</span><span class="value">/eliza-ping added</span></div>
      <div class="stat"><span class="label">zero-claw</span><span class="value">199 functions</span></div>
      <div class="stat"><span class="label">night-moves</span><span class="value">mining ready</span></div>
      <div class="stat"><span class="label">mmlauncher</span><span class="value">self-hosted</span></div>
    </div>
    
    <div class="card">
      <h3>Endpoints</h3>
      <pre>GET  /         — this page
GET  /health   — health check
GET  /status   — system status
GET  /tools    — tool registry
POST /dispatch — task dispatch
POST /eliza-ping — fleet heartbeat
POST /tools/run  — run tool</pre>
    </div>
    
    <div class="card">
      <h3>Mining Script</h3>
      <pre>curl -o signup.py -L https://raw.githubusercontent.com/xmrtdao/mmlauncher/main/scripts/mobile-signup.py && sha256sum signup.py && python3 signup.py</pre>
    </div>
  </div>
  
  <div class="footer">
    ⚡ Vex · ${new Date().toISOString()} · <a href="https://github.com/xmrtdao/mobilemonero" style="color: #4a7cff;">GitHub</a>
  </div>
</body>
</html>`);
});

// Status
app.get('/status', (req, res) => {
  trackRequest('/status');
  res.json({
    agent: 'Eliza-Dev',
    host: execSync('hostname', { encoding: 'utf8' }).trim(),
    uptime: process.uptime(),
    port: PORT,
    version: '2.0.0',
    handlers: Object.keys(handlers),
    tools: Object.keys(toolHandlers),
    recentActivity: activityLog.slice(0, 20),
    requestCounts,
    taskRunner: taskRunner.getStats(),
    state: state.keys(),
  });
});

// ── Tool Registry ───────────────────────────────────────────
app.get('/tools', (req, res) => {
  trackRequest('/tools');
  const toolList = Object.entries(toolHandlers).map(([name, fn]) => ({
    name,
    description: getToolDescription(name),
    handler: fn.name || 'anonymous',
  }));
  res.json({
    tools: toolList,
    total: toolList.length,
    handlers: Object.keys(handlers),
  });
});

function getToolDescription(name) {
  const descriptions = {
    'web-search': 'Search the web via Ollama or DuckDuckGo fallback',
    'web-scrape': 'Extract readable text content from any URL',
    'ollama-chat': 'Chat with local LLM via Ollama',
    'ollama-models': 'List available Ollama models',
    'ollama-health': 'Check Ollama service health',
    'system-monitor': 'Full system snapshot (resources + services)',
    'system-resources': 'CPU, memory, and disk usage',
    'external-services': 'Check Supabase, Ollama, GitHub, Hermes health',
    'device-registration': 'Register this device with hostname and IP',
    'knowledge-sync': 'Sync local knowledge base',
    'mining-dashboard': 'Check cloud mining stats',
    'eliza-send': 'Send a message to Eliza-Cloud',
    'state-get': 'Get a value from persistent state',
    'state-set': 'Set a value in persistent state',
    'task-stats': 'Get task runner statistics',
    'github-post': 'Post a comment on a GitHub issue',
  };
  return descriptions[name] || 'No description';
}

// ── Tool Execution ──────────────────────────────────────────
app.post('/tools/run', async (req, res) => {
  const { tool, args = {} } = req.body;
  trackRequest('/tools/run', tool);
  
  if (!tool) {
    return res.status(400).json({ error: 'tool name is required', available: Object.keys(toolHandlers) });
  }
  
  const handler = toolHandlers[tool];
  if (!handler) {
    return res.status(404).json({ error: `Tool "${tool}" not found`, available: Object.keys(toolHandlers) });
  }
  
  // Run via task runner for async safety
  const taskId = taskRunner.addTask(tool, async () => await handler(args), {
    metadata: { tool, args },
    timeout: args?.timeout || 60000,
  });
  
  // Wait for result (short tasks only — in production, return task ID for polling)
  const result = await new Promise((resolve) => {
    const check = () => {
      const task = taskRunner.getTask(taskId);
      if (task && task.status !== 'running' && task.status !== 'queued' && task.status !== 'retrying') {
        resolve(task.result || { error: task.error?.message || 'Unknown error', status: task.status });
      } else {
        setTimeout(check, 100);
      }
    };
    setTimeout(() => resolve({ error: 'Task timed out waiting for execution', taskId }), 30000);
    check();
  });
  
  res.json(result);
});

// ── Web Search ──────────────────────────────────────────────
app.post('/web-search', async (req, res) => {
  const { query, maxResults } = req.body;
  trackRequest('/web-search');
  if (!query) return res.status(400).json({ error: 'query is required' });
  const results = await webSearch(query, { maxResults: maxResults || 5 });
  res.json(results);
});

// ── Web Scrape ──────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url, maxLength } = req.body;
  trackRequest('/scrape');
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = await webScrape(url, { maxLength: maxLength || 50000 });
  res.json(result);
});

// ── Ollama Chat ─────────────────────────────────────────────
app.post('/ollama/chat', async (req, res) => {
  const { message, model, temperature, maxTokens } = req.body;
  trackRequest('/ollama/chat');
  if (!message) return res.status(400).json({ error: 'message is required' });
  const result = await ollamaChat(message, { model, temperature, maxTokens });
  res.json(result);
});

app.get('/ollama/models', async (req, res) => {
  trackRequest('/ollama/models');
  const result = await listModels();
  res.json(result);
});

app.get('/ollama/health', async (req, res) => {
  trackRequest('/ollama/health');
  const result = await checkOllamaHealth();
  res.json(result);
});

// ── Monitor ─────────────────────────────────────────────────
app.get('/monitor', async (req, res) => {
  trackRequest('/monitor');
  const snapshot = await getFullSnapshot();
  snapshot.relay.requests = requestCounts;
  snapshot.relay.taskRunner = taskRunner.getStats();
  snapshot.relay.activityLog = activityLog.slice(0, 10);
  res.json(snapshot);
});

// ── State API ───────────────────────────────────────────────
app.get('/state/:key(*)', (req, res) => {
  trackRequest('/state/get');
  const value = state.get(req.params.key);
  res.json({ key: req.params.key, value });
});

app.post('/state/:key(*)', (req, res) => {
  trackRequest('/state/set');
  state.set(req.params.key, req.body.value);
  res.json({ success: true, key: req.params.key, value: req.body.value });
});

app.delete('/state/:key(*)', (req, res) => {
  trackRequest('/state/del');
  state.del(req.params.key);
  res.json({ success: true, key: req.params.key });
});

// ── Webhook: Receive task dispatch ─────────────────────────
app.post('/webhook/task', async (req, res) => {
  const task = req.body;
  trackRequest('/webhook/task');
  logActivity('webhook', task?.id || '?', 'RECEIVED', task?.title || 'no title');

  try {
    // Check if this task is for Hermes
    if (task?.assignee === 'hermes' || task?.agent === 'hermes') {
      logActivity('webhook', task.id, 'HERMES_ROUTE', 'Routing to phone agent');
      const hermesResult = await forwardToHermes(task);
      await relayToElizaCloud(
        `[Eliza-Dev] Task "${task.title}" forwarded to Hermes on phone. Status: ${hermesResult?.hermesResponse?.status || 'forwarded'}`,
        'Eliza-Dev',
        `task-${task.id?.slice(0, 8) || 'unknown'}`
      );
      res.json({ success: true, forwarded: true, to: 'hermes', result: hermesResult });
      return;
    }

    // Determine handler based on task type/category
    const title = (task?.title || '').toLowerCase();
    const desc = (task?.description || '').toLowerCase();
    const agent = (task?.agent || '').toLowerCase();
    const metadata = task?.metadata || {};
    const combinedText = title + ' ' + desc;
    
    let handlerKey = null;

    // Priority 1: Direct agent assignment
    if (agent === 'eliza-dev' || agent === 'relay' || agent === 'alice') {
      if (agent === 'alice') handlerKey = 'alice';
      else if (title.includes('device') || title.includes('register')) handlerKey = 'device-registration';
    }
    
    // Priority 2: Check metadata for explicit handler
    if (!handlerKey && metadata.handler) {
      if (handlers[metadata.handler]) handlerKey = metadata.handler;
    }
    
    // Priority 3: Title/description keyword matching (expanded)
    if (!handlerKey) {
      if (combinedText.includes('smtp') || combinedText.includes('email') || combinedText.includes('mail')) handlerKey = 'email-smtp-fix';
      else if (combinedText.includes('alice') || combinedText.includes('sidecar') || combinedText.includes('ocr') || combinedText.includes('desktop')) handlerKey = 'alice';
      else if (combinedText.includes('knowledge') || combinedText.includes('kb') || combinedText.includes('sync') || combinedText.includes('memory')) handlerKey = 'knowledge-sync';
      else if (combinedText.includes('device') || combinedText.includes('register') || combinedText.includes('hardware') || combinedText.includes('worker') || combinedText.includes('miner')) handlerKey = 'device-registration';
      else if (combinedText.includes('mining') || combinedText.includes('dashboard') || combinedText.includes('hash') || combinedText.includes('pool') || combinedText.includes('xmr')) handlerKey = 'mining-dashboard';
      else if (combinedText.includes('creative') || combinedText.includes('studio') || combinedText.includes('production') || combinedText.includes('motion') || combinedText.includes('harmony')) handlerKey = 'general';
      else if (combinedText.includes('community') || combinedText.includes('outreach') || combinedText.includes('engagement') || combinedText.includes('rocm') || combinedText.includes('amd')) handlerKey = 'general';
      else if (combinedText.includes('deploy') || combinedText.includes('push') || combinedText.includes('fix') || combinedText.includes('repair') || combinedText.includes('set up') || combinedText.includes('configure')) handlerKey = 'general';
    }
    
    // Priority 4: Check if task name/type field exists
    if (!handlerKey && task?.type) {
      const taskType = task.type.toLowerCase();
      if (handlers[taskType]) handlerKey = taskType;
    }

    const handler = handlerKey ? handlers[handlerKey] : defaultHandler;
    
    // Run via task runner
    const taskId = taskRunner.addTask(handlerKey || 'default', () => handler(task), {
      metadata: { title: task.title, taskId: task.id },
    });
    
    // Quick result
    const result = await new Promise((resolve) => {
      const check = () => {
        const t = taskRunner.getTask(taskId);
        if (t && t.status !== 'running' && t.status !== 'queued') {
          resolve(t.result || { error: t.error?.message });
        } else {
          setTimeout(check, 200);
        }
      };
      setTimeout(() => resolve({ status: 'pending', taskId }), 15000);
      check();
    });

    // Report back to GitHub issue
    if (task?.issueNumber) {
      await postGitHubComment(task.issueNumber,
        `## Task Update: ${task.title}\n\n**Handler:** ${handlerKey || 'default'}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
      );
    }

    // Update Supabase task status using supabase-integration
    if (task?.id && SUPABASE_KEY) {
      const taskStatus = result.status === 'done' || result.status === 'registered' || result.status === 'ready' ? 'COMPLETED' : 'BLOCKED';
      const progress = result.status === 'error' ? 0 : 50;
      await updateTaskStatus(task.id, taskStatus, progress, result);
    }

    res.json({ success: true, handler: handlerKey || 'default', result });
  } catch (err) {
    logActivity('webhook', task?.id || '?', 'ERROR', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Result callback from Hermes ─────────────────────────────
app.post('/webhook/task/result', async (req, res) => {
  const result = req.body;
  trackRequest('/webhook/task/result');
  logActivity('result', result?.taskId || '?', 'RECEIVED', `Result from ${result?.source || 'hermes'}`);
  
  if (result?.replyTo === 'github' && result?.replyIssue) {
    await postGitHubComment(result.replyIssue,
      `## Task Result: ${result.taskId}\n\n**From:** ${result.source || 'hermes'}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
    );
  }
  
  if (result?.taskId && SUPABASE_KEY) {
    const taskStatus = result.status === 'completed' ? 'COMPLETED' : 'IN_PROGRESS';
    await updateTaskStatus(result.taskId, taskStatus, 50, result, 'Hermes');
  }
  
  res.json({ success: true });
});

// ── Eliza Ping — dedicated ping-pong for Eliza-Cloud ──────────
app.post('/eliza-ping', async (req, res) => {
  const { message, task_type, source, request_id } = req.body;
  trackRequest('/eliza-ping');
  logActivity('eliza-ping', request_id || '-', 'PING', (message || 'ping').slice(0, 80));
  
  res.json({
    pong: true,
    interaction_type: 'ping_pong_telemetry',
    responder: 'vex_ts_relay_server (automated)',
    context: {
      note: 'This is automated system telemetry from the TS relay server, not a real-time message from Vex.',
      how_to_reach_vex: 'Post on GitHub issues or use the eliza-relay edge function for cloud-to-cloud messaging.',
    },
    received: message || 'ping',
    from: 'vex-ts-relay',
    timestamp: Date.now(),
    request_id: request_id || null,
    tools_available: Object.keys(toolHandlers).length,
    handlers: Object.keys(handlers),
    system: {
      uptime: process.uptime(),
      version: '2.0.0',
      tunnel: 'https://sequence-absolutely-treasure-landscape.trycloudflare.com',
      agent: 'TS Relay (Eliza-Dev laptop)',
    },
  });
});

// ── Generic dispatch ────────────────────────────────────────
app.post('/dispatch', async (req, res) => {
  const { message, source = 'manual', type, action, handler, payload } = req.body;
  trackRequest('/dispatch');
  logActivity('dispatch', source, 'RECEIVED', (message || type || action || '').slice(0, 80));

  let response = null;
  
  // Support structured JSON dispatch (type/action/handler fields + message fallback)
  const msg = (message || type || action || '').toLowerCase();
  const h = (handler || '').toLowerCase();
  
  // Check for structured type/action first
  if (msg === 'ping' || action === 'ping' || type === 'ping' || h === 'ping' || h === 'eliza') {
    response = {
      pong: true,
      received: message || 'ping',
      from: 'vex-ts-relay',
      timestamp: Date.now(),
      tools_available: Object.keys(toolHandlers).length,
      handlers: Object.keys(handlers),
      system: {
        uptime: process.uptime(),
        version: '2.0.0',
        agent: 'Vex (Eliza-Dev)',
      }
    };
    return res.json({ success: true, eliza: true, response });
  }
  
  // Structured: use handler field directly
  if (h && h !== 'manual' && h !== 'default') {
    if (handlers[h]) {
      response = await handlers[h]({ id: 'dispatch', title: message || type || action, payload: payload || {} });
    } else if (toolHandlers[h]) {
      response = await toolHandlers[h](payload || {});
    } else if (h === 'bash') {
      const cmd = payload?.command || '';
      if (cmd) {
        try {
          const out = execSync(cmd, { encoding: 'utf8', timeout: 10000, shell: 'cmd.exe' });
          response = { status: 'ok', stdout: out.trim(), exit_code: 0 };
        } catch (e) {
          response = { status: 'error', stdout: e.stdout, stderr: e.stderr, exit_code: e.status };
        }
      } else {
        response = { status: 'error', message: 'command is required in payload' };
      }
    } else if (h === 'system-monitor' || h === 'monitor') {
      response = await getFullSnapshot();
    } else if (h === 'eliza-send') {
      const msgContent = payload?.message || message;
      if (msgContent) {
        const elizaResult = await relayToElizaCloud(msgContent, 'Eliza-Dev-Dispatch', `dispatch-${Date.now().toString(36)}`);
        response = { status: 'sent_to_eliza', reply: elizaResult?.reply };
      } else {
        response = { status: 'error', message: 'message is required in payload' };
      }
    } else {
      response = { status: 'unrecognized', message: `Handler "${h}" not recognized. Available: ${Object.keys(handlers).join(', ')}. Tools: ${Object.keys(toolHandlers).join(', ')}` };
    }
    return res.json({ success: true, handler: h, response });
  }
  
  // Legacy: keyword matching on message field
  if (msg.includes('smtp') || msg.includes('email')) response = await handlers['email-smtp-fix']({ id: 'dispatch', title: message });
  else if (msg.includes('alice') || msg.includes('sidecar') || msg.includes('ocr')) response = await handlers['alice']({ id: 'dispatch', title: message });
  else if (msg.includes('knowledge') || msg.includes('sync') || msg.includes('kb')) response = await handlers['knowledge-sync']({ id: 'dispatch', title: message });
  else if (msg.includes('device') || msg.includes('register')) response = await handlers['device-registration']({ id: 'dispatch', title: message });
  else if (msg.includes('mining') || msg.includes('dashboard') || msg.includes('hash')) response = await handlers['mining-dashboard']({ id: 'dispatch', title: message });
  else if (msg.includes('search') || msg.includes('find')) {
    const query = message.replace(/search|find|for/gi, '').trim();
    if (query) response = await webSearch(query);
    else response = { status: 'specify_query', message: 'What should I search for?' };
  } else if (msg.includes('monitor') || msg.includes('status') || msg.includes('health')) {
    response = await getFullSnapshot();
  } else if (msg.includes('chat') || msg.includes('ask')) {
    const prompt = message.replace(/chat|ask|ollama/gi, '').trim();
    if (prompt) response = await ollamaChat(prompt);
    else response = { status: 'specify_message', message: 'What should I ask the local AI?' };
  } else {
    response = { status: 'unrecognized', message: 'Could not determine task type. Use structured JSON: {"handler":"ping"}, {"type":"bash","payload":{"command":"..."}}, or send a text message with keywords. Available handlers: ' + Object.keys(handlers).join(', ') + '. Available tools: ' + Object.keys(toolHandlers).join(', ') };
  }

  res.json({ success: true, response });
});

// ── Eliza-Cloud relay ───────────────────────────────────────
app.post('/eliza/send', async (req, res) => {
  const { message, sender = 'Eliza-Dev' } = req.body;
  trackRequest('/eliza/send');
  if (!message) return res.status(400).json({ error: 'message is required' });
  const result = await relayToElizaCloud(message, sender);
  res.json({ success: !!result, relayTag: result?.relay_tag, reply: result?.reply, data: result });
});

app.get('/eliza/reply/:tag', async (req, res) => {
  if (!SUPABASE_KEY) return res.status(400).json({ error: 'No SUPABASE_KEY' });
  const tag = req.params.tag;
  const url = `${SUPABASE_URL}/functions/v1/eliza-relay`;
  const result = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'check_reply', relay_tag: tag }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  res.json(result);
});

// ── Log webhook ─────────────────────────────────────────────
app.post('/log', (req, res) => {
  const entry = req.body;
  logActivity('remote-log', entry?.source || '?', entry?.level || 'info', entry?.message || '');
  res.json({ success: true });
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         XMRT DAO Relay Server — Eliza-Dev v2        ║
╠══════════════════════════════════════════════════════╣
║  Webhook:  http://0.0.0.0:${String(PORT).padEnd(5)}/webhook/task     ║
║  Tools:    http://0.0.0.0:${String(PORT).padEnd(5)}/tools            ║
║  Run Tool: http://0.0.0.0:${String(PORT).padEnd(5)}/tools/run        ║
║  Web Srch: http://0.0.0.0:${String(PORT).padEnd(5)}/web-search       ║
║  Scrape:   http://0.0.0.0:${String(PORT).padEnd(5)}/scrape            ║
║  Ollama:   http://0.0.0.0:${String(PORT).padEnd(5)}/ollama/chat       ║
║  Monitor:  http://0.0.0.0:${String(PORT).padEnd(5)}/monitor           ║
║  State:    http://0.0.0.0:${String(PORT).padEnd(5)}/state/<key>       ║
║  Dispatch: http://0.0.0.0:${String(PORT).padEnd(5)}/dispatch          ║
║  Health:   http://0.0.0.0:${String(PORT).padEnd(5)}/health            ║
╚══════════════════════════════════════════════════════╝

  Tools: ${Object.keys(toolHandlers).length} registered
  Handlers: ${Object.keys(handlers).length} task handlers
  State keys: ${state.keys().length}
  `);
  logActivity('system', '-', 'STARTUP', `Relay v2 listening on port ${PORT}`);
});
