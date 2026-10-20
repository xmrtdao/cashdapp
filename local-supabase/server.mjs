#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// local-supabase: drop-in local replacement for the Supabase
// public API. Exposes the same path layout as supabase.co so
// the suite's @supabase/supabase-js client works without code
// changes:
//   /rest/v1/*        — PostgREST-compatible REST (Node + pg)
//   /functions/v1/*   — Deno edge function runner
//   /auth/v1/*        — GoTrue-compatible stub
//   /storage/v1/*     — Storage stub (local disk)
//   /realtime/v1/*    — WebSocket stub (NOOP broadcast)
// ──────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from this dir, then parent relay/.env fallback.
// File wins over process.env — we are a local dev stack and the .env is
// the source of truth. This also defeats the case where a polluted parent
// shell (e.g. a long-running agent session that exports OLLAMA_API_KEY=ollama
// as a placeholder) leaks broken values into every deno subprocess we spawn.
function loadEnvFile(p, { override = true } = {}) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (override || !process.env[k]) process.env[k] = v;
  }
}
loadEnvFile(join(__dirname, '.env'), { override: true });
loadEnvFile(join(__dirname, '..', 'relay', '.env'), { override: true });

const PORT = parseInt(process.env.LOCAL_SUPABASE_PORT || '54321', 10);
const HOST = process.env.LOCAL_SUPABASE_HOST || '127.0.0.1';
const LOCAL_DB_URL = process.env.LOCAL_DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
const FUNCTIONS_DIR = process.env.SUPABASE_FUNCTIONS_DIR
  || join(__dirname, '..', 'suite', 'supabase', 'functions');
const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  || join(__dirname, 'storage-data');

const DENO_PATH = process.env.DENO_PATH
  || join(__dirname, '..', 'bin', 'deno', 'deno.exe');

const SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwic3ViIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAxIiwiYXVkIjoiYXV0aGVudGljYXRlZCIsImV4cCI6MjA5ODI5OTYxNCwiaWF0IjoxNzgyOTM5NjE0LCJpc3MiOiJsb2NhbC1zdXBhYmFzZSJ9.2TX-Izr0KH_YIcC9SAqaBJr4bgVlnNMPPfT7v2XMMpM';
const ANON_KEY = process.env.LOCAL_SUPABASE_ANON_KEY
  || 'local-anon-key';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '50mb' }));

// ── Request logger ──
app.use((req, _res, next) => {
  const t = Date.now();
  process.nextTick(() => {
    const ms = Date.now() - t;
    console.log(`[local-sb] ${req.method} ${req.url} → ${ms}ms`);
  });
  next();
});

// ── Auth context (parses Bearer / apikey) ──
app.use((req, _res, next) => {
  const auth = req.headers['authorization'] || '';
  const apikey = req.headers['apikey'] || '';
  let role = 'anon';
  let uid = null;
  // Treat the service-role key (or a JWT issued with role:service_role) as service_role
  const rawTok = auth.startsWith('Bearer ') ? auth.slice(7) : (apikey || '');
  if (rawTok && rawTok !== 'undefined' && rawTok !== 'null') {
    if (rawTok === SERVICE_ROLE_KEY) {
      role = 'service_role';
      uid = '00000000-0000-0000-0000-000000000001';
    } else {
      const parts = rawTok.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
          role = payload.role || 'authenticated';
          uid = payload.sub || null;
        } catch { /* not a JWT, treat as anon */ }
      }
    }
  }
  req.supabaseCtx = { role, uid, apikey, rawToken: auth };
  next();
});

// ── Set the Postgres role for RLS ──
app.use(async (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  next();
});

// ── Shared PG pool for local-sb ──
let _sbPool = null;
function getSbPool() {
  if (!_sbPool) {
    const pg = require('pg');
    const { POOL_CONFIG } = require('../relay/lib/pool-config.mjs');
    _sbPool = new pg.Pool({ connectionString: LOCAL_DB_URL, ...POOL_CONFIG.localSb });
    _sbPool.on('error', (err) => console.error('[local-sb] pool error:', err.message));
  }
  return _sbPool;
}

// ── Health / root ──
app.get('/', (_req, res) => {
  res.json({
    name: 'local-supabase',
    version: '0.1.0',
    endpoints: ['/rest/v1', '/functions/v1', '/auth/v1', '/storage/v1', '/realtime/v1'],
    db: { url: LOCAL_DB_URL.replace(/:[^:@/]*@/, ':***@') },
    deno: { path: DENO_PATH, available: existsSync(DENO_PATH) },
    functionsDir: FUNCTIONS_DIR,
    storageDir: STORAGE_DIR,
  });
});

app.get('/health', (_req, res) => {
  // Health check returns INSTANTLY without a DB query. The supervisor probes
  // /health with a short timeout to decide if local-sb is alive; a DB-backed
  // probe (SELECT now()) hangs >4s when the shared pool (max 20) saturates
  // under dashboard load, so the supervisor falsely declared local-sb dead
  // and kill-restarted it ("port open but health check failed"). A health
  // check should confirm the process is serving, not that postgres is fast.
  res.json({ ok: true, db: 'xmrt_suite', ts: new Date().toISOString() });
});

// ── Mount route modules ──
const restRouter = (await import('./routes/rest.mjs')).default;
const functionsRouter = (await import('./routes/functions.mjs?v=' + Date.now())).default;
const authRouter = (await import('./routes/auth.mjs')).default;
const storageRouter = (await import('./routes/storage.mjs')).default;
const realtimeRouter = (await import('./routes/realtime.mjs')).default;

app.use('/rest/v1', restRouter({ dbUrl: LOCAL_DB_URL }));
app.use('/functions/v1', functionsRouter({
  functionsDir: FUNCTIONSDir(FUNCTIONS_DIR),
  denoPath: DENO_PATH,
}));
app.use('/auth/v1', authRouter({ dbUrl: LOCAL_DB_URL }));
app.use('/storage/v1', storageRouter({ storageDir: STORAGE_DIR, dbUrl: LOCAL_DB_URL }));
app.use('/realtime/v1', realtimeRouter());

function FUNCTIONSDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

// Ensure storage dir exists
if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('[local-sb] error:', err?.stack || err);
  res.status(500).json({ error: err?.message || 'internal_error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[local-sb] listening on http://${HOST}:${PORT}`);
  console.log(`[local-sb] db: ${LOCAL_DB_URL.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`[local-sb] functions: ${FUNCTIONS_DIR}`);
  console.log(`[local-sb] storage: ${STORAGE_DIR}`);
  console.log(`[local-sb] deno: ${DENO_PATH} (${existsSync(DENO_PATH) ? 'OK' : 'MISSING'})`);
});

// ── WebSocket upgrade for realtime ──
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/realtime/v1')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[realtime] ws connected');
      ws.send(JSON.stringify({ event: 'phx_reply', payload: { status: 'ok' } }));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Accept heartbeats and topic joins but no-op broadcast
          if (msg.event === 'heartbeat') {
            ws.send(JSON.stringify({ event: 'phx_reply', payload: { status: 'ok' }, ref: msg.ref }));
          } else if (msg.event === 'phx_join' || msg.event === 'phx_leave') {
            ws.send(JSON.stringify({ event: msg.event === 'phx_join' ? 'phx_reply' : 'phx_close', payload: { status: 'ok' }, ref: msg.ref, topic: msg.topic }));
          }
        } catch { /* ignore */ }
      });
      ws.on('close', () => console.log('[realtime] ws closed'));
    });
  } else {
    socket.destroy();
  }
});

process.on('SIGINT', () => { console.log('\n[local-sb] SIGINT, shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { console.log('\n[local-sb] SIGTERM, shutting down'); server.close(() => process.exit(0)); });
