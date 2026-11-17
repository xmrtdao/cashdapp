#!/usr/bin/env node
/**
 * supervisor.mjs — Proper Windows daemon for XMRT DAO local stack
 *
 * Manages all services with health checks, auto-restart, and flapping
 * detection. Writes to relay-data/supervisor-state.json so the relay's
 * /api/supervisor/status endpoint reflects real state.
 *
 * Usage:
 *   node supervisor.mjs --serve     # Run the daemon (foreground)
 *   node supervisor.mjs --daemon    # Self-detach as background daemon
 *   node supervisor.mjs --once      # Single health-check tick (for Task Scheduler)
 *   node supervisor.mjs --status    # Print status and exit
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, statSync, openSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import http from 'node:http';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ── relay/.env ────────────────────────────────────────────────────────────
//
// A service runs with the supervisor's own environment, and the supervisor's
// environment is whatever the operator's launcher happened to have. Two things
// a service needs are not in it: the OpenCode API key, and the one password
// the OpenCode server and its client must agree on. relay/.env is where both
// live, so it is read here - once, at boot - and handed to the services that
// ask for them.
//
// This was the reason the fleet could not drive OpenCode at all: the server
// took its password from the supervisor's environment, the client had no way
// to know it, and every connection was refused. Two sides that read the same
// file cannot disagree.
const RELAY_ENV = (() => {
  try {
    const p = join(ROOT, 'relay', '.env');
    if (!existsSync(p)) return {};
    const out = {};
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
})();

// Pick a concrete Python interpreter for services we supervise.
//
// Supervising `py` (the Windows Python Launcher) supervises a process that exits
// as soon as it has dispatched to the real interpreter. The child handle goes
// stale immediately, the health check short-circuits on it, and the service is
// restarted in a loop while it is demonstrably still serving. Anything we
// supervise for more than one tick has to BE the long-lived process.
function resolvePython() {
  const candidates = [
    join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'python';
}
const DATA_DIR = join(ROOT, 'relay-data');
const LOG_DIR = join(ROOT, 'logs');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const PID_FILE = join(DATA_DIR, 'supervisor.pid');
const STATE_FILE = join(DATA_DIR, 'supervisor-state.json');
const LOG_FILE = join(LOG_DIR, 'supervisor.log');

// An operator - or the relay's own service_control - can take the supervisor
// out of service on purpose. The watchdog task fires every couple of minutes,
// so without this marker it would undo a deliberate stop within one tick.
const DISABLED_FILE = join(DATA_DIR, 'supervisor.disabled');

// ── Logging ──────────────────────────────────────────────────────────
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;

function rotateLogIfNeeded() {
  try {
    const st = statSync(LOG_FILE);
    if (st.size > MAX_LOG_SIZE) {
      // Rotate: log -> log.1 -> log.2 -> ... -> log.5 (delete oldest)
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
        const dst = `${LOG_FILE}.${i}`;
        try {
          if (existsSync(src)) {
            if (i === MAX_LOG_FILES - 1 && existsSync(dst)) unlinkSync(dst);
            renameSync(src, dst);
          }
        } catch {}
      }
    }
  } catch {}
}

function log(line) {
  const stamp = new Date().toISOString();
  const full = `${stamp} [supervisor] ${line}`;
  console.log(full);
  try {
    rotateLogIfNeeded();
    appendFileSync(LOG_FILE, full + '\n');
  } catch {}
}

// ── Service definitions ──────────────────────────────────────────────
const SERVICE_DEFS = [
  {
    name: 'relay',
    cmd: 'node',
    args: ['--max-old-space-size=512', 'relay/server.js'],
    cwd: ROOT,
    tcpPort: 8080,
    // HTTP health check: a wedged relay keeps TCP 8080 LISTENING but stops
    // answering HTTP (event-loop block). A bare TCP check reports it healthy
    // forever, so the supervisor never restarts it. Checking /health with a
    // short timeout catches that — checkHttp() times out if no response.
    healthUrl: 'http://127.0.0.1:8080/health',
    healthCheck: (body) => {
      try { const d = JSON.parse(body); return d && d.status === 'ok'; } catch { return false; }
    },
    startupGraceMs: 90000,
    maxFailures: 2,
    dependsOn: ['pg', 'local-sb', 'health-server'],
  },
  {
    name: 'health-server',
    cmd: 'node',
    args: ['relay/health-server.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:8088/ping',
    healthCheck: (body) => {
      try { const d = JSON.parse(body); return d && d.ok === true; } catch { return false; }
    },
    startupGraceMs: 3000,
    maxFailures: 3,
    dependsOn: [],
  },
  {
    name: 'campaign-scheduler',
    cmd: 'node',
    args: ['relay/campaign-scheduler.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    startupGraceMs: 5000,
    dependsOn: ['pg'],
  },
  {
    name: 'opencode',
    cmd: join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    args: ['serve', '--port', '4096', '--hostname', '0.0.0.0'],
    cwd: ROOT,
    env: {
      // The key lives in relay/.env, not in this file. A credential in source
      // is a credential in every copy, every backup and every transcript that
      // quotes the file - and the one that was here answered 401 "Invalid
      // credential", so it was not even doing the job it was there for.
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || RELAY_ENV.OPENCODE_API_KEY || '',
      OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL || RELAY_ENV.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1',
      // The server and its client have to agree on ONE password. The client is
      // the fleet's worker, and it reads this same file, so both sides take
      // the value from here rather than from whatever the supervisor's own
      // environment happened to carry - which is how the two ended up
      // disagreeing and every connection was refused.
      OPENCODE_PASSWORD: RELAY_ENV.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD || '',
      OPENCODE_SERVER_PASSWORD: RELAY_ENV.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '',
      // Cascade / free-model fallback — same as relay/suite (OpenRouter + local ollama)
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || RELAY_ENV.OPENROUTER_API_KEY || '',
      OPENROUTER_MODELS: (process.env.OPENROUTER_MODELS || RELAY_ENV.OPENROUTER_MODELS || 'minimax/minimax-m3.1-flash,liquid/lfm-2.5-2.6b:free,apodex/apodex-1.1-mini:free,google/gemma-3-4b-it:free,thinkingmachines/inkling-small:free,nvidia/nemotron-3.5-lightning:free').toString(),
      OLLAMA_URL: process.env.OLLAMA_URL || RELAY_ENV.OLLAMA_URL || 'http://localhost:11434',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || RELAY_ENV.OLLAMA_MODEL || 'minimax-m3.1-flash',
    },
    healthCheck: () => checkHttp('http://127.0.0.1:4096/health', 2000),
    startupGraceMs: 10000,
    maxRestartsPerHour: 3,
    dependsOn: [],
  },
  {
    // The browser this stack owns. It is the one browser an agent can read:
    // the operator's dashboard pane is an iframe in somebody else's window,
    // but this one is a real Chrome with a control API (/navigate, /click,
    // /type, /text, /elements, /fill, /press) and a live frame stream.
    //
    // It was written and never supervised, so it was only ever alive while
    // somebody had started it by hand.
    name: 'browser-view',
    cmd: 'node',
    args: ['relay/browser-view.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:9334/status',
    tcpPort: 9334,
    startupGraceMs: 15000,
    maxRestartsPerHour: 3,
    dependsOn: [],
  },
  {
    // The OpenCode worker: the file-based bridge (agent-inbox/opencode/ ->
    // agent-outbox/opencode/) that lets anything queue a prompt for an agent
    // with hands. It used to spawn the OpenCode CLI, which never answered -
    // the CLI and the server disagreed about the password, and the CLI's own
    // background service was not the one running. It talks to the server over
    // HTTP now, through the proxy that injects the credential.
    name: 'opencode-agent',
    cmd: 'node',
    args: ['relay/opencode-agent.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:9335/health',
    tcpPort: 9335,
    startupGraceMs: 10000,
    maxRestartsPerHour: 3,
    dependsOn: ['opencode'],
  },
  {
    name: 'cuttlefishclaws-mcp',
    cmd: 'node',
    args: ['relay/cuttlefishclaws-mcp.mjs', '--http', '--port', '3120'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:3120/health',
    // The port is the authority when the endpoint does not answer. Without
    // tcpPort the check fell through to "is the child process alive", and a
    // process that is alive but no longer listening reported healthy forever -
    // which is how the cuttlefish MCP went down and stayed down.
    tcpPort: 3120,
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'xmrtdao-suite-mcp',
    cmd: 'node',
    args: ['relay/xmrtdao-suite-mcp.mjs', '--http', '--port', '3121'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:3121/health',
    tcpPort: 3121,
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'page-agent-mcp',
    // Alibaba Page Agent — JavaScript in-page GUI agent for natural language web control.
    // Provides MCP stdio server on port 38401 (hub) for browser automation.
    // Used for dashboard observation, E2E testing, and fleet chat interaction.
    // Chrome extension at ~/Desktop/page-agent-extension connects to localhost:38401.
    cmd: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\PureTrek\\Desktop\\page-agent\\packages\\mcp\\src\\index.js'],
    cwd: 'C:\\Users\\PureTrek\\Desktop\\page-agent\\packages\\mcp',
    healthUrl: null, // check via process existence (stdio MCP)
    healthCheck: null,
    tcpPort: 38401, // hub port — prevents false "external" adoption via node.exe
    startupGraceMs: 5000,
    dependsOn: [],
  },
  {
    name: 'pg',
    // Pure Node launcher (relay/start-pg.mjs) — replaces the old
    // start-pg-hidden.vbs wrapper. windowsHide: true suppresses the
    // checkpointer / bgwriter / wal_writer child console windows.
    cmd: process.execPath,
    args: ['relay/start-pg.mjs'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    tcpPort: 5432,          // TCP port for health checking
    startupGraceMs: 2000,
    dependsOn: [],
  },
  {
    name: 'local-sb',
    cmd: 'node',
    args: ['local-supabase/server.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:54321/health',
    healthCheck: (body) => typeof body === 'object',
    tcpPort: 54321,
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'vite',
    cmd: 'node',
    // .bin/vite is a #!/bin/sh script on Windows — node cannot run it.
    // Point node directly at vite's JS entry point instead.
    args: ['node_modules/vite/bin/vite.js', '--port', '5173', '--host', '127.0.0.1'],
    cwd: join(ROOT, 'suite'),
    healthUrl: 'http://127.0.0.1:5173/',
    healthCheck: () => true,  // any HTTP response = alive
    startupGraceMs: 10000,
    dependsOn: [],
  },
  // ── Tunnel & Zone Agent ───────────────────────────────────────
  {
    name: 'cloudflared-agent',
    cmd: 'node',
    args: ['relay/cloudflared-agent.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:20243/metrics',
    tcpPort: 20243,
    startupGraceMs: 15000,
    maxRestartsPerHour: 3,
    dependsOn: ['tunnel'],
  },
  {
    // The main mobilemonero tunnel: suite / relay / jobby / atreyus / graytech.
    //
    // It is a cloudflared.exe, exactly like `designer` below, so process-name
    // detection cannot tell the two apart. With no metrics listener the old
    // definition fell back to "any cloudflared.exe exists", which reported a
    // dead tunnel healthy whenever the OTHER tunnel was running — and after a
    // reboot it also adopted a stale childPid that now belonged to vite.
    //
    // Bind metrics on 20242 (the port the relay's status map already expects
    // for this service) so identity and liveness are both port-based: a dead
    // tunnel now reads DOWN instead of inheriting "any cloudflared.exe exists".
    // The `healthCheck` below records the same connection-count test `designer`
    // declares, but checkServiceHealth does not consult it yet (see the note on
    // resume-server) — liveness here is "the :20242 metrics endpoint answers".
    name: 'tunnel',
    cmd: join(ROOT, 'cloudflared.exe'),
    args: ['tunnel', '--config', join(homedir(), '.cloudflared', 'config.yml'),
           '--metrics', '127.0.0.1:20242', 'run'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:20242/metrics',
    healthCheck: (body) => /cloudflared_tunnel_ha_connections\s+(\d+)/.test(body)
                          && Number(body.match(/cloudflared_tunnel_ha_connections\s+(\d+)/)[1]) > 0,
    startupGraceMs: 15000,
    tcpPort: 20242,
    dependsOn: ['relay'],
  },
  {
    // The client-facing print studio. Its own tunnel, in the zone's own
    // Cloudflare account — the account boundary is why a cross-account CNAME
    // 530'd until this tunnel existed inside the right one.
    //
    // Token is read from ~/.cloudflared/<id>.token at startup, never stored
    // in source. Connection-based health: the old 'tunnel' service only checks
    // process existence, so a disconnected cloudflared reads HEALTHY while the
    // host is actually down. This one is deliberately different.
    // Runs the PFP tunnel with a LOCAL config rather than --token.
    //
    // This changed for a concrete reason. `cloudflared run --token` takes its
    // ingress from the Cloudflare dashboard, so adding a hostname to a local
    // file does nothing -- which is why book.partyfavorphoto.com could not be
    // added. A named tunnel run with --config reads ingress from disk, so
    // hostnames become version-visible and changeable without a dashboard.
    //
    // Two traps this encodes:
    //   - protocol: http2 lives in pfp-config.yml and IS read in this form. It
    //     is absent from the token form because that form never reads a config
    //     at all. QUIC over UDP 7844 does not reach the edge from this network;
    //     the process starts, holds zero connections, and serves 530 while
    //     looking alive.
    //   - The local config is only consulted if the tunnel is NOT remotely
    //     managed. Prints resolves and book returns 404 today, which is the
    //     signature of a remotely-managed tunnel whose dashboard ingress knows
    //     only about prints. Until that public hostname is added in the
    //     dashboard, book.partyfavorphoto.com stays 404 regardless of this file.
    name: 'designer',
    cmd: join(ROOT, 'cloudflared.exe'),
    args: ['tunnel', '--config', join(homedir(), '.cloudflared', 'pfp-config.yml'),
           '--metrics', '127.0.0.1:20243', 'run'],
    cwd: ROOT,
    // Port 20243, not 20242. The config form does NOT default to exposing
    // metrics the way the token form did, so the address is pinned here rather
    // than assumed: with no --metrics the process binds nothing, this healthUrl
    // can never answer, and the supervisor restarts a perfectly healthy tunnel
    // forever. 20243 rather than 20242 so it cannot collide with the
    // mobilemonero tunnel's own metrics listener.
    healthUrl: 'http://127.0.0.1:20243/metrics',
    healthCheck: (body) => /cloudflared_tunnel_ha_connections\s+(\d+)/.test(body)
                          && Number(body.match(/cloudflared_tunnel_ha_connections\s+(\d+)/)[1]) > 0,
    startupGraceMs: 15000,
    // Identity for findExistingProcess: the metrics listener distinguishes this
    // tunnel from the main one (both are cloudflared.exe, so the exe-name
    // fallback would conflate them and "adopt" the wrong one). With tcpPort
    // declared, a missing :20243 means not-running, so tick starts it at once.
    tcpPort: 20243,
    dependsOn: ['relay'],
  },
  {
    name: 'alice',
    cmd: 'node',
    args: ['relay/alice.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,  // check via process existence
    healthCheck: null,
    startupGraceMs: 8000,
    dependsOn: ['relay'],
  },
  {
    name: 'cron-engine-v2',
    cmd: 'node',
    args: ['relay/cron-engine-v2.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,  // check via process existence
    healthCheck: null,
    startupGraceMs: 5000,
    dependsOn: ['relay'],
  },
  {
    // The SIEM. It polls the events this stack already collects, runs the
    // rules in relay/lib/security.mjs over them, keeps the alert lifecycle and
    // tells the fleet when something is worth telling them.
    //
    // It was in START_ORDER with NO entry in SERVICE_DEFS, so tick() hit
    // `if (!def) continue;` and skipped it every single time. The service was
    // never started and never restarted - it has been down since 2026-11-12.
    // An unsupervised service that looks supervised is worse than one that is
    // visibly absent: the name in the start order said "we look after this".
    //
    // No HTTP port: it is a polling loop, so health is process existence.
    name: 'security',
    cmd: 'node',
    args: ['relay/security-service.mjs'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    startupGraceMs: 8000,
    dependsOn: ['pg', 'relay'],
  },
  {
    // The thing that decides whether a task has earned the right to finish.
    // It closes tasks that are genuinely done and returns the ones that are
    // not. Without it the task board has no closure rule, and the evidence
    // gate in AGENTS.md has nothing enforcing it.
    //
    // Same as `security`: it was in START_ORDER with no SERVICE_DEFS entry, so
    // it was skipped every tick and has been down since 2026-11-12.
    name: 'verifier',
    cmd: 'node',
    args: ['relay/verifier-service.mjs'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    startupGraceMs: 8000,
    dependsOn: ['pg', 'relay'],
  },
  {
    // Local inference. Installed at C:\Users\PureTrek\AppData\Local\Programs\Ollama
    // with 17 models on disk, including the custom gemma3-xmrt the Suite
    // cascade's local fallback tier falls back to. The harness registry had
    // recorded it as 'healthy' while nothing was listening on :11434, so the
    // local fallback was dead for weeks and nothing ever started the server.
    //
    // It is supervised now. GET /api/tags answers 200 with the model list
    // when it is up; a bare TCP check would pass while the server was broken.
    name: 'ollama',
    cmd: 'C:\\Users\\PureTrek\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
    args: ['serve'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:11434/api/tags',
    tcpPort: 11434,
    startupGraceMs: 60000,
    dependsOn: [],
  },
  {
    // DeepSeek Harness web UI — Builder's workspace + watchable harness on :3080.
    // The detached .cjs launcher sets DEEPSEEK_BASE_URL/API_KEY in the child env
    // and writes the one-time auth-token URL to dsh/dsh-web-harness.log (that's
    // the file dsh-open reads to open an authenticated window). Health is TCP :3080
    // (the bare URL returns a 401 auth-wall, which is the healthy state, so a raw
    // HTTP probe would false-negative — a TCP port check is correct here).
    name: 'dsh',
    cmd: 'node',
    args: ['dsh/dsh-web-supervised.cjs'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    tcpPort: 3080,
    startupGraceMs: 30000,
    dependsOn: ['relay'],
  },
  {
    name: 'resume-server',
    // The interpreter itself, NOT `py`.
    //
    // `py` is the Python Launcher: it dispatches to the real interpreter and then
    // exits. So the supervisor was supervising a wrapper that had already left —
    // the child pid it tracked went stale within seconds of every spawn, while
    // the actual server (a python.exe the launcher had started) kept serving.
    // That produced a restart roughly every six minutes for a service that was
    // answering HTTP 200 the entire time, with exit code 3221225786
    // (0xC000013A, STATUS_CONTROL_C_EXIT — an orderly exit, not a crash).
    //
    // The candidates are what `py` resolves to on this machine, listed in order.
    // If none exists, fall back to `python` on PATH rather than failing to spawn:
    // a missing interpreter should be a visible spawn error, not a silent
    // fallback to the launcher that caused this in the first place.
    cmd: resolvePython(),
    args: ['resume_server.py', '--host', '127.0.0.1', '--port', '5175'],
    cwd: join(ROOT, 'jobby-mcjobberson'),
    healthUrl: 'http://127.0.0.1:5175/',
    // NOTE: `healthCheck` on a service definition is never read. checkServiceHealth
    // consults healthUrl, then tcpPort, then the child pid — it never looks at
    // def.healthCheck. A `healthCheck: () => true` here therefore did nothing at
    // all, which is worth knowing before anyone writes another one expecting it
    // to be authoritative.
    healthCheck: () => true,
    startupGraceMs: 5000,
    dependsOn: [],
  },
  {
    // AstraGaze / GrayTech Security - the face recognition console published at
    // graytech.mobilemonero.com through the cloudflared tunnel.
    //
    // Supervised because it was not, and that is how it went dark: the process
    // had been started by hand from a shell that has since closed, so nothing
    // brought it back when it died, and there was no entry here to restart it.
    // A public demo that cannot survive a crash is not a service.
    //
    // The venv is the project's own rather than a system python, and cwd is the
    // project root because both `graytech.server:app` and the `app` package
    // resolve relative to it. `--workers 1` is not optional: each worker loads
    // its own copy of the recognition model.
    name: 'graytech',
    cmd: join(ROOT, 'face-service', '.venv', 'Scripts', 'python.exe'),
    args: ['-m', 'uvicorn', 'graytech.server:app', '--host', '127.0.0.1', '--port', '8090', '--workers', '1'],
    cwd: join(ROOT, 'face-service'),
    healthUrl: 'http://127.0.0.1:8090/health',
    // The model load is slow, so a short grace would restart-loop a service that
    // was merely still booting. Measured cold start on this machine: ~70s from
    // spawn to answering /health (insightface + SCRFD/ArcFace load), so the grace
    // is set above that with margin. At 60s a cold start could fail its first
    // probe and get restarted while it was still coming up.
    startupGraceMs: 95000,
      // The port this service listens on, declared on the definition rather than
      // left to the module-level port map.
      //
      // That map was the actual cause of the flapping. There are four copies of
      // it in this file and graytech appeared in NONE of them, so every restart
      // path skipped the two things that make a restart reliable:
      //
      //   * killing the real port owner, so a stale instance survived and the
      //     fresh spawn died on EADDRINUSE - which is the EXIT code=1 two seconds
      //     after spawn in the log, not a crash;
      //   * waiting for the port to be released before spawning.
      //
      // So the sequence was: kill the child, spawn immediately, new instance
      // loses the port race, exits, count a failure, wait three ticks, retry. The
      // service was down for 74-92s at a time and each attempt could lose the
      // race again. Declaring tcpPort here makes all four call sites work,
      // because each one already reads `def.tcpPort || tcpPorts[name]`.
      tcpPort: 8090,
      // Two consecutive failures to the threshold, not the default three.
      //
      // startupGraceMs only covers a process that is still booting. Once the
      // process is up and then dies, startedAt is old, so every probe counts
      // immediately, and at ~33s per tick a dead service takes 100s to recover.
      // Measured from the log: 92s and 74s outages on consecutive deaths.
      //
      // For this service a dead process is unambiguous - /health answers in
      // milliseconds once the model is loaded (16ms measured), so a failure is a
      // genuine one and not a slow boot or a blip.
      maxFailures: 2,
    dependsOn: [],
  },
  {
    // Atreyus AI Takeoff — backend (FastAPI + contour detector on :8000)
    // and frontend (Vite on :5174, published as atreyus.mobilemonero.com
    // through the tunnel's `atreyus` ingress).
    //
    // Two services, not one wrapper script: start.ps1 spawned two children
    // into one supervised process, so killing one half orphaned the other and
    // the health check could only ever see one of them. The supervisor's model
    // is one long-lived child per service name (the same reason resume-server
    // runs resolvePython() and never the `py` launcher).
    //
    // The backend is python.exe, NOT pythonw.exe. Under pythonw there is no
    // stdout at all, and one `print(..., flush=True)` in the request path ends
    // the response as a bare 500 — observed as "AI backend unavailable (backend
    // 500)" while the same endpoint answered fine when piped. The supervisor's
    // stdio redirect to a log file also needs a real handle.
    name: 'atreyus-backend',
    cmd: resolvePython(),
    args: ['main.py'],
    cwd: join(ROOT, 'atreyus', 'backend_ai'),
    healthUrl: 'http://127.0.0.1:8000/health',
    healthCheck: null,
    tcpPort: 8000,
    // First cold start compiles nothing but does import cv2/fastapi — tens of
    // seconds is normal on this machine's disk.
    startupGraceMs: 60000,
    dependsOn: [],
  },
  {
    // Atreyus AI Takeoff — frontend. Vite dev server on :5174.
    // `--host 0.0.0.0` matches vite.config.mjs so the tunnel's Host header
    // (atreyus.mobilemonero.com, in allowedHosts) is not rejected;
    // binding only to 127.0.0.1 would still work for the tunnel, which connects
    // from localhost, but the config already asks for the wider bind.
    name: 'atreyus-frontend',
    cmd: 'cmd',
    args: ['/c', 'npm run dev'],
    cwd: join(ROOT, 'atreyus'),
    healthUrl: 'http://127.0.0.1:5174/',
    healthCheck: () => true,  // any HTTP response = alive
    tcpPort: 5174,
    startupGraceMs: 30000,
    dependsOn: ['atreyus-backend'],
  },
  {
    name: 'atreyus-backend',
    cmd: 'python',
    args: ['atreyus/backend_ai/main.py'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:8001/health',
    tcpPort: 8001,
    startupGraceMs: 10000,
    dependsOn: [],
  },
  {
    name: 'atreyus-frontend',
    cmd: 'node',
    args: ['node_modules/vite/bin/vite.js', '--port', '5174', '--host', '127.0.0.1'],
    cwd: join(ROOT, 'atreyus'),
    healthUrl: 'http://127.0.0.1:5174/',
    tcpPort: 5174,
    startupGraceMs: 15000,
    dependsOn: [],
  },
  {
    name: 'atreyus-proxy',
    cmd: 'node',
    args: ['relay/atreyus-proxy.mjs'],
    cwd: ROOT,
    tcpPort: 8000,
    startupGraceMs: 2000,
    dependsOn: ['atreyus-backend'],
  },
  {
    // OpenFilm Studio — the AI video agent. Its UI is on :4747 and the film
    // renderer on :4748; main.mjs supervises its own worker (5 respawns/min)
    // and advertises itself in ~/.openfilm/run.json, so `openfilm` CLI
    // clients and the relay tool reuse THIS instance instead of spawning a
    // second Studio. One Studio per machine is the design; the supervisor
    // owns main.mjs, main.mjs owns the worker.
    //
    // Run from the GLOBAL install, not npx: the npx cache path is
    // content-addressed and replaced on update, and the supervisor needs a
    // stable path to a long-lived child. Global copy is
    // %APPDATA%\npm\node_modules\openfilm (v0.3.2), installed with
    // `npm i -g openfilm@0.3.2`.
    //
    // Health is /api/health, which answers {product:'openfilm-studio'} when
    // the studio server is really serving. A bare TCP check would pass on a
    // wedged process that still holds 4747.
    name: 'openfilm',
    cmd: process.execPath,
    args: [join(process.env.APPDATA || '', 'npm', 'node_modules', 'openfilm', 'studio', 'server', 'main.mjs')],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:4747/api/health',
    tcpPort: 4747,
    // Cold start measured ~3s to /api/health; model/UI assets load after.
    startupGraceMs: 30000,
    maxRestartsPerHour: 3,
    dependsOn: [],
  },
  {
    // Hermes — the stdio gateway. It has no HTTP port and never will: the
    // dashboard drives it through its MCP servers, and its health is "the
    // gateway process is alive". It was running (pid recorded in the harness
    // registry as health_mode 'process') but belonged to nobody, so a crash
    // meant the fleet's chat/research/mining gateway stayed down.
    //
    // Identity is the module path in the command line, not the exe: pythonw.exe
    // is shared with every other Python service on this box.
    name: 'hermes',
    cmd: 'C:\\Users\\PureTrek\\AppData\\Roaming\\uv\\python\\cpython-3.11-windows-x86_64-none\\pythonw.exe',
    args: ['-m', 'hermes_cli.main', 'gateway', 'run'],
    cwd: ROOT,
    processMatch: 'hermes_cli.main',
    healthUrl: null,  // stdio gateway: health is process existence
    healthCheck: null,
    startupGraceMs: 10000,
    dependsOn: [],
  },
  {
    // MOSS-TTS-Nano — the local voice model (0.1B, CPU, 48kHz) OpenFilm's
    // voice-over path is built on. It is a FastAPI/uvicorn server
    // (MOSS-TTS-Nano/app.py, default port 18083) whose model load is slow
    // enough that a short grace would restart-loop it, so the grace is set
    // from the measured cold start (~2 min to LISTEN on this box).
    //
    // NOTE: the relay tool `tts-generate` still calls infer_onnx.py as a
    // one-shot process; supervising this server keeps the harness's own HTTP
    // surface alive but does not route the tool through it.
    name: 'moss-tts',
    cmd: 'C:\\Users\\PureTrek\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe',
    args: ['app.py', '--port', '18083', '--host', '127.0.0.1'],
    cwd: join(ROOT, 'MOSS-TTS-Nano'),
    healthUrl: 'http://127.0.0.1:18083/',
    tcpPort: 18083,
    startupGraceMs: 180000,
    maxFailures: 2,
    dependsOn: [],
  },
];

// graytech is independent of every other service - it needs no database and no
// tunnel to answer on :8090 - so it starts last and blocks nothing.
// atreyus-frontend depends on atreyus-backend, so both go after 'tunnel' as
// leaves; the frontend must come after the backend in the order.
const START_ORDER = ['pg', 'local-sb', 'ollama', 'vite', 'health-server', 'cuttlefishclaws-mcp', 'xmrtdao-suite-mcp', 'page-agent-mcp', 'relay', 'tunnel', 'designer', 'alice', 'cron-engine-v2', 'security', 'verifier', 'campaign-scheduler', 'opencode', 'opencode-agent', 'browser-view', 'dsh', 'resume-server', 'graytech', 'atreyus-backend', 'atreyus-frontend', 'openfilm', 'hermes', 'moss-tts'];

// ── State ────────────────────────────────────────────────────────────
const state = {};
let shuttingDown = false;

function getStateFilePath() { return STATE_FILE; }

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        return {
          services: raw.services || {},
          alerts: raw.alerts || {},
          lastTaskCheck: raw.lastTaskCheck || 0,
          lastTaskResults: raw.lastTaskResults || {},
          _pid: raw._pid,
          _updatedAt: raw._updatedAt,
        };
      }
    }
  } catch {}
  return { services: {}, alerts: {}, lastTaskCheck: 0, lastTaskResults: {} };
}

function saveState() {
  const out = loadState();
  const now = Date.now();
  for (const [name, s] of Object.entries(state)) {
    if (!out.services[name]) out.services[name] = {};
    // The live pid of the service, whoever owns it.
    //
    // This was `s.child?.pid || null`. An ADOPTED service - one that was
    // already running when this supervisor started - has no child handle, so
    // that wrote null and dropped the pid we had just recorded for it. The
    // state file is the only durable record of what is running; with the pid
    // gone, the NEXT supervisor start read the file, found nothing tracked
    // for that service, and the startup sweep killed the live process as a
    // "stale port owner". The sweep was killing services it had just adopted.
    out.services[name].childPid = s.child?.pid || s.externalPid || null;
    out.services[name].startedAt = s.startedAt || out.services[name].startedAt || now;
    if (s.healthy !== undefined) out.services[name].healthy = s.healthy;
    if (s.failures !== undefined) out.services[name].failures = s.failures;
    // `degradedBy` is cleared rather than copied when absent, so a recovered
    // dependency does not leave a stale degradation marker behind.
    if (s.degradedBy && s.degradedBy.length) out.services[name].degradedBy = s.degradedBy;
    else delete out.services[name].degradedBy;
    if (s.isExternal) out.services[name].isExternal = true;
  }
  out._pid = process.pid;
  out._updatedAt = now;
  try { writeFileSync(STATE_FILE, JSON.stringify(out, null, 2)); } catch (e) { log(`saveState error: ${e.message}`); }
}

function writePid() {
  try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
}

// ── Process helpers ──────────────────────────────────────────────────
function isProcessRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findProcessByName(name) {
  // On Windows, use tasklist /NH /FO CSV to find processes by name
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /NH /FO CSV /FI "IMAGENAME eq ${name}"`, {
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
      });
      return out.includes(name);
    }
    // Linux/Mac
    const out = execSync(`pgrep -f "${name}" 2>/dev/null`, {
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    return out.length > 0;
  } catch {
    // tasklist or pgrep returns non-zero exit if no process found
    return false;
  }
}

// ── Process table ───────────────────────────────────────────────────
//
// One `wmic process` call enumerates every node.exe on the box with its
// command line. Asking for one service at a time cost 30+ wmic calls per
// tick, and wmic is slow: the tick was measured at up to 167 seconds, so the
// state file the product reads was minutes stale, and the portless services
// failed their health check whenever a wmic call timed out - a service that
// was demonstrably running was reported DOWN.
//
// The table is refreshed at most once every PROCESS_TABLE_TTL_MS and filtered
// in JS. The matching semantics are unchanged: a case-insensitive substring
// match on the command line, exactly like the `LIKE '%...%'` it replaces.
const PROCESS_TABLE_TTL_MS = 15000;
let processTable = null;   // { rows: [{pid, cmd}], at: number }

function refreshProcessTable() {
  const now = Date.now();
  if (processTable && (now - processTable.at) < PROCESS_TABLE_TTL_MS) {
    return processTable.rows;
  }
  try {
    const out = execSync(
      `wmic process where "name='node.exe'" get ProcessId,ParentProcessId,CommandLine /format:csv`,
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000, encoding: 'utf8', windowsHide: true }
    );
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      // wmic's CSV is `Node,CommandLine,ParentProcessId,ProcessId` - the columns
      // come out in ALPHABETICAL order, not the order they were asked for, and
      // the quoting is broken: a command line containing a comma is wrapped in
      // an opening quote and never closed. So the pid is always the LAST field,
      // the parent the one before it, and the command line is everything between
      // the first comma and the last two.
      // Parsing it the documented way silently produced an empty table, which
      // made every script-name lookup miss.
      const m = line.trim().match(/^[^,]*,(.*),(\d+),(\d+)\s*$/);
      if (!m) continue;
      const pid = parseInt(m[3], 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const ppid = parseInt(m[2], 10) || 0;
      let cmd = m[1].trim();
      if (cmd.startsWith('"')) cmd = cmd.slice(1);
      if (cmd.endsWith('"')) cmd = cmd.slice(0, -1);
      rows.push({ pid, ppid, cmd });
    }
    processTable = { rows, at: now };
  } catch {
    // wmic failed. Keep the previous table rather than reporting every
    // service as gone - a failed query is not evidence of absence.
    if (!processTable) processTable = { rows: [], at: now };
  }
  return processTable.rows;
}

function findProcessByScript(scriptName) {
  // Find a node process running a specific script — returns ALL matching PIDs
  // (not just the first) so the supervisor can self-prune duplicates.
  try {
    const needle = String(scriptName).toLowerCase();
    if (!needle) return null;
    const rows = refreshProcessTable();
    const pids = rows
      .filter(r => r.cmd.toLowerCase().includes(needle))
      .map(r => r.pid);
    return pids.length > 0 ? pids : null;
  } catch {
    return null;
  }
}

// ── Self-pruning ───────────────────────────────────────────────────
// Keep one healthy process per supervised service and kill duplicates.
// This is the guard against the known failure mode where repeated
// supervisor/relay/mcp launches accumulate (double relay on :8080, three
// cuttlefishclaws-mcp daemons, etc.) and silently eat RAM until the box
// OOMs. For each service it enumerates every matching PID, keeps the one
// that owns the service's TCP port (or the single instance if a service
// runs portless), and kills the rest — skipping its own children so a
// legitimately restarted service isn't reaped.
function pruneDuplicateProcesses() {
  const tcpPorts = { pg: 5432, 'local-sb': 54321, relay: 8080, vite: 5173, 'cuttlefishclaws-mcp': 3120, 'xmrtdao-suite-mcp': 3121, 'cuttlefish-mcp': 3122, dsh: 3080 };
  let pruned = 0;

  for (const name of START_ORDER) {
    const def = SERVICE_DEFS.find(d => d.name === name);
    if (!def) continue;

    const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js'));
    if (!scriptName) continue;
    // Use the full relative path (e.g. "relay/health-server.mjs") for matching
    // instead of just the base name — prevents false positives where "server.mjs"
    // also matches "health-server.mjs".
    const matchPath = scriptName.replace(/^[/\\]+/, '');

    let pids;
    try { pids = findProcessByScript(matchPath); } catch { continue; }
    // Parent map, so a service's own tree is never pruned as a "duplicate".
    // The failure mode this prevents: self-supervising services (OpenFilm
    // main.mjs spawns its worker with the SAME script path) match their own
    // worker in the script lookup, and the prune killed it every tick - a
    // crash loop on a 30s timer.
    const parentOf = new Map(refreshProcessTable().map(r => [r.pid, r.ppid || 0]));
    const isDescendantOf = (/** @type {number} */ pid, /** @type {number} */ ancestor) => {
      if (!ancestor) return false;
      let cur = parentOf.get(pid) ?? 0;
      for (let depth = 0; depth < 16 && cur > 0; depth++) {
        if (cur === ancestor) return true;
        cur = parentOf.get(cur) ?? 0;
      }
      return false;
    };
    if (!pids || pids.length < 2) {
      // single instance (or none) — nothing to prune for this service
      if (pids && pids.length === 1) continue;
      continue;
    }

    // Determine which PID is the "keeper":
    //   1. the supervisor's own live child for this service, if any
    //   2. else the PID owning the service's TCP port
    let keeper = null;
    if (state[name]?.child && !state[name].child.killed) {
      keeper = state[name].child.pid;
    } else {
      const port = def.tcpPort || tcpPorts[name];
      if (port) {
        try {
          const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
          const m = out.match(/(\d+)\s*$/m);
          if (m) keeper = parseInt(m[1], 10);
        } catch {}
      }
    }

    for (const pid of pids) {
      if (pid === process.pid) continue;             // never kill ourselves
      if (pid === state[name]?.child?.pid) continue; // never kill our managed child
      if (pid === keeper) continue;                  // keep the one serving
      // An ADOPTED service (already running when this daemon started) has no
      // managed child; its tree is state.externalPid's. And a self-supervising
      // service (OpenFilm main.mjs spawns its worker with the SAME script path)
      // puts the port owner INSIDE that tree: main is the ancestor of the
      // keeper, worker is its descendant. Either direction of the same tree is
      // legitimate - pruning it is how a healthy Studio gets crash-looped.
      const roots = [state[name]?.child?.pid, state[name]?.externalPid, keeper].filter(Boolean);
      let inTree = false;
      for (const root of roots) {
        if (pid === root || isDescendantOf(pid, root) || isDescendantOf(root, pid)) { inTree = true; break; }
      }
      if (inTree) continue;
      // Heuristic safety: never kill a relay/MCP that the relay actively tracks
      // (avoid reaping during a restart race). Only prune if not the keeper.
      try { killProcess(pid); pruned++; log(`[self-prune] ${name}: killed duplicate pid ${pid} (keeper=${keeper})`); }
      catch {}
    }
  }
  if (pruned > 0) log(`[self-prune] pruned ${pruned} duplicate process(es)`);
}

function killProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
}

// ── HTTP health check ────────────────────────────────────────────────
async function checkHttp(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function checkTcpPort(host, port, timeoutMs = 2000) {
  // Try the given host first, then the other loopback (IPv4/IPv6).
  // Some services (e.g. page-agent-mcp) bind only ::1, so a 127.0.0.1
  // check would falsely report "not running" and cause duplicate spawns.
  const hosts = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : host === '::1' ? ['::1', '127.0.0.1'] : [host];
  for (const h of hosts) {
    const ok = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(timeoutMs);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, h);
    });
    if (ok) return true;
  }
  return false;
}

// ── Process detection ────────────────────────────────────────────────
//
// The one true port map. This was duplicated as a local `const` inside four
// separate functions, and they had drifted: one copy had 'cuttlefish-mcp',
// three did not, and graytech was in none of them. A service missing from a copy
// silently loses every port-aware behaviour at that call site - it is not an
// error, the lookup just returns undefined and the branch is skipped. That is
// precisely how graytech came to lose the port-kill and port-wait on restart and
// then start failing EADDRINUSE.
//
// Definitions remain the source of truth: `def.tcpPort` wins, and this map is
// only the fallback for services that predate the field.
const TCP_PORTS = { pg: 5432, 'local-sb': 54321, relay: 8080, vite: 5173, 'cuttlefishclaws-mcp': 3120, 'xmrtdao-suite-mcp': 3121, 'cuttlefish-mcp': 3122, dsh: 3080, graytech: 8090, opencode: 4096, 'browser-view': 9334, 'opencode-agent': 9335 };

async function findExistingProcess(name) {
  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) return null;

  // A pid persisted in the state file is only trusted for services that have
  // NO TCP port to identify them by. After a reboot Windows reuses PIDs, so a
  // childPid written before the reboot can name a completely unrelated process
  // now — this is exactly how a dead `tunnel` was adopted as healthy because
  // vite had inherited its old pid, and the box came up with no external
  // access while the supervisor reported 24/24 healthy. A listening port
  // cannot be inherited that way, so for port-declared services the port is
  // the only trustworthy identity and the stale pid is ignored below.
  const tcpPorts = TCP_PORTS;
  const declaredPort = def.tcpPort || tcpPorts[name];
  if (!declaredPort) {
    // Read the existing state file (populated by server.js / previous runs)
    const st = loadState();
    const existing = st.services?.[name]?.childPid;
    if (existing && isProcessRunning(existing)) return existing;
  }

  // For services with HTTP health, try a quick check
  if (def.healthUrl && !def.healthUrl.includes('127.0.0.1:0')) {
    try {
      // 2s was too short for a busy relay: /health occasionally takes 2-3s
      // when the event loop is doing GC or serving a burst. Every such sample
      // made this function conclude the service was dead and kill it — the
      // relay then restarted, and the next slow /health killed it again. A
      // liveness probe must tolerate a busy process; it exists to catch a
      // wedged one, not to punish a slow response.
      const alive = await checkHttp(def.healthUrl, 6000);
      if (alive) return -1; // running externally, unknown PID
      // If health check fails but port is open, kill the stale process —
      // unless the child we launched is still alive. A live child holding the
      // port is a busy service, not a stale one.
      if (declaredPort) {
        const portOpen = await checkTcpPort('127.0.0.1', declaredPort, 1000);
        if (portOpen) {
          const trackedPid = state[name]?.child?.pid || state[name]?.externalPid;
          if (trackedPid) {
            let trackedAlive = false;
            try { process.kill(trackedPid, 0); trackedAlive = true; } catch {}
            if (trackedAlive) {
              log(`${name} port ${declaredPort} is open and tracked pid ${trackedPid} is alive but /health was slow — treating as running`);
              return trackedPid;
            }
          }
          log(`${name} port ${declaredPort} is open but health check failed — killing stale process`);
          // Find what's on that port and kill it
          try {
            const pids = execSync(`netstat -ano | findstr ":${declaredPort} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
            const pidMatch = pids.match(/(\d+)\s*$/m);
            if (pidMatch) {
              killProcess(parseInt(pidMatch[1]));
              log(`${name} killed stale pid ${pidMatch[1]} on port ${declaredPort}`);
            }
          } catch {}
        }
      }
    } catch {}
  }

  // For services known by TCP port, try a socket connect
  const port = def.tcpPort || tcpPorts[name];
  if (port) {
    try {
      const alive = await checkTcpPort('127.0.0.1', port, 1000);
      if (alive) return -1;
      // Explicit tcpPort that is NOT listening → not running, start it.
      // Do NOT fall through to the .exe fallback (node.exe is always running
      // and would falsely report "adopting" for page-agent-mcp).
      if (def.tcpPort) return null;
    } catch {}
  }

  // For services without HTTP/TCP (schedulers, alice, cron-engine, tunnel):
  // check by process name / script name
  const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js'));
  if (scriptName) {
    const pids = findProcessByScript(scriptName.replace(/^.*[/\\]/, ''));
    if (pids && pids.length > 0) return pids[0];
  }
  // A service whose identity is a module inside a generic interpreter
  // (pythonw -m hermes_cli.main ...) matches neither a script name nor an
  // exe name - and the exe-name fallback would adopt ANY pythonw on the
  // machine. def.processMatch is the command-line substring that identifies
  // this service's process.
  if (def.processMatch) {
    const pids = findProcessByScript(def.processMatch);
    if (pids && pids.length > 0) return pids[0];
  }
  if (def.cmd && def.cmd.endsWith('.exe')) {
    const exeName = def.cmd.split(/[/\\]/).pop();
    if (findProcessByName(exeName)) return -1;
  }

  return null;
}

// ── Service lifecycle ────────────────────────────────────────────────
async function startService(name) {
  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) { log(`unknown service: ${name}`); return; }

  if (state[name] && state[name].child && !state[name].child.killed) {
    log(`${name} already running (pid ${state[name].child.pid})`);
    return;
  }

  log(`starting ${name}: ${def.cmd} ${def.args.join(' ')}`);

  try {
    // ── Redirect stdio to log files ─────────────────────────────
    // Pipes ('pipe') fill up the 64KB OS buffer and block the child's event
    // loop. 'ignore' maps to NUL on Windows which can also block console.log
    // in detached processes. Redirecting to a file is the only safe option —
    // files have no buffer limit, writes never block, and we get crash logs.
    const serviceLogPath = join(LOG_DIR, `${name}.log`);
    let logFd, errFd;
    try {
      // Truncate if > 5MB, otherwise append
      try {
        const st = statSync(serviceLogPath);
        if (st.size > 5 * 1024 * 1024) {
          logFd = openSync(serviceLogPath, 'w');
        } else {
          logFd = openSync(serviceLogPath, 'a');
        }
      } catch {
        logFd = openSync(serviceLogPath, 'w');
      }
      errFd = logFd; // stdout + stderr go to same file
    } catch (e) {
      log(`Warning: could not open log file for ${name}: ${e.message}`);
    }
    // Do not spawn on top of a port we are still releasing.
    //
    // This is the second half of the graytech flapping, and it is separate from
    // the missing tcpPort. The health-failure path kills the port owner and waits
    // for release (with tcpPort now declared, graytech finally takes that path),
    // but this function - startService - is also reached from the tick loop when
    // no live process is found, and it spawned immediately. A uvicorn process
    // that has just been killed can hold :8090 for a moment while Windows reaps
    // it, so the new one lost the bind and exited with code 1 within ~2 seconds.
    // That exit then counted as a failure, which cost another 60-90 seconds.
    //
    // Checking first costs a couple of seconds in the rare case where the port
    // really is free, and saves a full restart cycle in the case where it is not.
    const wantPort = def.tcpPort || TCP_PORTS[def.name];
    if (wantPort) {
      let waited = 0;
      while (waited < 15000) {
        let busy = false;
        try { busy = await checkTcpPort('127.0.0.1', wantPort, 500); } catch { busy = false; }
        if (!busy) break;
        if (waited === 0) {
          log(`  ${name}: port ${wantPort} still held, waiting for release`);
        }
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
      if (waited > 0) {
        log(`  ${name} waited ${waited}ms for port ${wantPort}`);
        let stillBusy = false;
        try { stillBusy = await checkTcpPort('127.0.0.1', wantPort, 500); } catch { stillBusy = false; }
        if (stillBusy) {
          // Something is holding it and did not let go in 15s. Find and kill the
          // owner rather than spawning into a guaranteed EADDRINUSE.
          try {
            const out = execSync(`netstat -ano | findstr ":${wantPort} " | findstr LISTENING`,
                                 { encoding: 'utf8', timeout: 5000, windowsHide: true });
            const m = out.match(/(\d+)\s*$/m);
            if (m) {
              const owner = parseInt(m[1], 10);
              if (owner && owner !== process.pid) {
                log(`  ${name}: port ${wantPort} still held by pid ${owner}, killing it`);
                killProcess(owner);
                await new Promise(r => setTimeout(r, 1500));
              }
            }
          } catch { /* best effort */ }
        }
      }
    }

    // Substitute secret placeholders at launch time, never from source. A
    // @{FILE:<path>} token is read from disk here; a @{ENV:<name>} token is
    // read from the environment. The value is never logged.
    let resolvedArgs = def.args;
    if (def.args.some(a => typeof a === 'string' && a.startsWith('@{FILE:'))) {
      resolvedArgs = def.args.map(a => {
        const m = typeof a === 'string' && a.match(/^@\{FILE:([^}]+)\}$/);
        if (!m) return a;
        try { return readFileSync(m[1], 'utf8').trim(); }
        catch (e) {
          log(`  ${name}: could not read secret file ${m[1]}: ${e.message}`);
          return null;
        }
      });
      if (resolvedArgs.some(a => a === null)) {
        log(`  ${name}: NOT starting — a secret file was missing or unreadable`);
        return;
      }
    }

    const child = spawn(def.cmd, resolvedArgs, {
      cwd: def.cwd,
      detached: true,
      stdio: ['ignore', logFd || 'ignore', errFd || 'ignore'],
      windowsHide: true,
      // A service's own env is applied LAST, so what it declares wins over
      // whatever the supervisor inherited. It used to be ignored entirely,
      // which meant a service could declare an env and never receive it.
      env: { ...process.env, ...(def.env || {}) },
    });
    let stderrBuf = '';
    // Flush on exit — write any captured stderr to the crash log
    child.on('exit', (code, signal) => {
      log(`${name} EXIT: code=${code} signal=${signal}`);
      if (stderrBuf) {
        log(`${name} STDERR (last 10KB):\n${stderrBuf}`);
        try {
          const crashEntry = `[${new Date().toISOString()}] ${name} (pid=${child.pid}) EXIT code=${code} signal=${signal}\n${stderrBuf.slice(-2000)}\n---\n`;
          appendFileSync('C:/Users/PureTrek/Desktop/xmrtdao/logs/process-crashes.log', crashEntry);
        } catch (e) { /* best effort */ }
      }
    });
    child.unref();
    state[name] = {
      child,
      failures: 0,
      startedAt: Date.now(),
      healthy: false,
    };
    log(`  ${name} spawned as pid ${child.pid}`);
    saveState();
  } catch (e) {
    log(`  ${name} spawn FAILED: ${e.message}`);
  }
}

function stopService(name) {
  const s = state[name];
  if (!s || !s.child) return;
  log(`stopping ${name} (pid ${s.child.pid})`);
  killProcess(s.child.pid);
  delete state[name];
  saveState();
}

function stopAll() {
  log('stopping all services...');
  for (const name of [...START_ORDER].reverse()) {
    stopService(name);
  }
  try { writeFileSync(STATE_FILE, JSON.stringify({ services: {}, alerts: {}, _stoppedAt: Date.now() }, null, 2)); } catch {}
  try { writeFileSync(PID_FILE, ''); } catch {}
  log('all services stopped');
}

// ── Health checking ──────────────────────────────────────────────────
async function checkServiceHealth(name) {
  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) return false;

  const s = state[name];

  // A DEFINED HEALTH ENDPOINT IS THE AUTHORITY.
  //
  // This used to sit behind the child-pid check, which meant a stale child handle
  // could report a service dead while it was answering requests — observed on
  // resume-server, which the supervisor restarted every ~6 minutes while
  // curl was getting HTTP 200 from it throughout. The pid is bookkeeping; the
  // endpoint is the service. When both are available, the endpoint decides, and
  // the pid is only asked as a fallback for services that have no endpoint.
  //
  // The one case this deliberately does NOT cover: a service whose endpoint
  // still answers after its process died (a port left held by a child of the
  // child). That is handled by sweeping stale port owners on restart, not by
  // trusting a pid we already know is wrong.
  if (def.healthUrl) {
    const ok = await checkHttp(def.healthUrl);
    if (ok) return true;
    // Endpoint did not answer. A dead child is then corroborating evidence, not
    // a separate verdict — fall through rather than short-circuit, so a service
    // on a TCP port with a broken URL can still be recognised as alive.
  }

  // 1. Check if our managed child process is alive
  if (s && s.child) {
    try { process.kill(s.child.pid, 0); } catch { /* stale handle; keep looking */ }
  }

  // 3. TCP port check (for services like pg that listen on a port but have no HTTP)
  if (def.tcpPort) {
    return await checkTcpPort('127.0.0.1', def.tcpPort, 2000);
  }

  // 4. Our tracked process is alive (for spawned services without HTTP/TCP
  //    like schedulers, and for adopted ones).
  //
  //    `s.externalPid` is the pid of an ADOPTED service - one that was already
  //    running when this supervisor started, so it has no child handle. It was
  //    ignored here, so every portless service (alice, cron-engine-v2,
  //    campaign-scheduler, security, verifier, dsh, browser-view,
  //    opencode-agent, tunnel) fell through to a wmic search of the whole
  //    process table on every tick. Under load those searches timed out and
  //    a service that was demonstrably running was reported DOWN.
  //
  //    A pid check is a syscall. It costs nothing and it cannot be slow.
  const trackedPid = s?.child?.pid || s?.externalPid;
  if (trackedPid) {
    try { process.kill(trackedPid, 0); return true; } catch {}
  }

  // 5. For services with no HTTP/TCP/tracked pid: check process by script
  //    name in the live table. This catches cases where the tracked reference
  //    is stale but a healthy instance exists.
  const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js') || a.endsWith('.exe'));
  if (scriptName) {
    if (findProcessByScript(scriptName.replace(/^.*\//, ''))) return true;
  }
  if (def.cmd && def.cmd.endsWith('.exe')) {
    const exeName = def.cmd.split(/[/\\]/).pop();
    if (findProcessByName(exeName)) return true;
  }

  return false;
}

// ── Tick ─────────────────────────────────────────────────────────────
async function tick() {
  const stateFile = loadState();

  // ── Process agent-queued service actions ──
  // The relay's `service_control` tool writes actions to service-actions.json;
  // the supervisor executes them here. Without this, queued restarts pile up
  // with `processed: false` forever and agents' restart requests never happen.
  try {
    const queueFile = join(DATA_DIR, 'service-actions.json');
    if (existsSync(queueFile)) {
      const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const pending = queue.filter(a => !a.processedAt);
        for (const action of pending) {
          const def = SERVICE_DEFS.find(d => d.name === action.service);
          if (!def) {
            log(`service_control: unknown service "${action.service}"`);
            action.processedAt = Date.now();
            action.result = 'unknown_service';
            continue;
          }
          if (action.action === 'restart') {
            log(`service_control: restarting ${action.service} (requested by ${action.requestedBy || 'unknown'})`);
            // Kill the port owner first (handles external/adopted services whose
            // childPid is null — stopService() alone can't kill them, and a fresh
            // spawn would crash with EADDRINUSE while the old process holds the port).
            const tcpPorts = TCP_PORTS;
            const port = def.tcpPort || tcpPorts[action.service];
            if (port) {
              try {
                const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
                const pidMatch = out.match(/(\d+)\s*$/m);
                if (pidMatch) {
                  const ownerPid = parseInt(pidMatch[1], 10);
                  if (ownerPid && ownerPid !== process.pid) {
                    log(`service_control: killing port ${port} owner pid ${ownerPid}`);
                    killProcess(ownerPid);
                  }
                }
              } catch {}
            }
            stopService(action.service);
            await startService(action.service);
            action.processedAt = Date.now();
            action.result = 'restarted';
          } else if (action.action === 'start') {
            const healthy = await checkServiceHealth(action.service);
            if (!healthy) {
              log(`service_control: starting ${action.service} (requested by ${action.requestedBy || 'unknown'})`);
              await startService(action.service);
              action.processedAt = Date.now();
              action.result = 'started';
            } else {
              log(`service_control: ${action.service} already healthy, skipping start`);
              action.processedAt = Date.now();
              action.result = 'already_healthy';
            }
          } else if (action.action === 'stop') {
            log(`service_control: stopping ${action.service} (requested by ${action.requestedBy || 'unknown'})`);
            stopService(action.service);
            action.processedAt = Date.now();
            action.result = 'stopped';
          } else if (action.action === 'status') {
            // status is handled inline by the relay tool, not queued
            action.processedAt = Date.now();
            action.result = 'status_inline';
          }
        }
        writeFileSync(queueFile, JSON.stringify(queue, null, 2));
      }
    }
  } catch (e) {
    log(`service_control queue processing error: ${e.message}`);
  }

  for (const name of START_ORDER) {
    if (shuttingDown) return;

    const def = SERVICE_DEFS.find(d => d.name === name);
    if (!def) continue;

    // Check if process already exists (maybe started by previous supervisor run)
    const existingPid = await findExistingProcess(name);

    if (existingPid) {
      // Process exists — adopt it if we haven't already
      const isUnknownPid = existingPid === -1;
      if (!state[name]) {
        log(`${name} already running externally${isUnknownPid ? '' : ` (pid ${existingPid})`} — adopting`);
        const prev = stateFile.services?.[name];
        state[name] = {
          child: null,
          externalPid: isUnknownPid ? null : existingPid,
          failures: 0,
          // Same reasoning as boot(): an adopted service was already running,
          // so it inherits when it started and its last known verdict rather
          // than being reset to "not started, not healthy".
          startedAt: prev?.startedAt || Date.now(),
          healthy: prev?.healthy === true,
          isExternal: true,
        };
      }
      // Health check
      await performHealthCheck(name, def);
    } else if (state[name]?.isExternal) {
      // External process died — remove from state so we restart it
      log(`${name} external process died — will restart`);
      delete state[name];
    } else {
      // Process not found — need to start
      const s = state[name];
      if (!s || !s.child || s.child.killed) {
        await startService(name);
        continue;
      }
      // Our child should be running — health check
      await performHealthCheck(name, def);
    }

    // Check dependency health.
    //
    // This used to write `state[name].healthy = false` and nothing ever wrote
    // it back to true: `performHealthCheck` above only *raises* healthy to
    // true, and it runs before this block, so a service that was latched false
    // by an unhealthy dependency stayed false forever even after the service
    // itself and all its dependencies recovered. dsh (dependsOn: ['relay'])
    // got stuck reporting unhealthy after a relay restart, which is what made
    // service_control tell agents dsh was down while it had been up for hours.
    //
    // Degradation is now recorded as its own field and never overwrites the
    // service's own health verdict.
    if (def.dependsOn) {
      const unhealthyDeps = def.dependsOn.filter(d => !state[d]?.healthy);
      // The entry can be missing by this point: the branches above delete it
      // when an external process dies or a service is started, so the service
      // will be (re)started next tick. Writing here unconditionally threw
      // "Cannot set properties of undefined (setting 'degradedBy')" and took
      // the whole tick down with it.
      const entry = state[name];
      if (!entry) {
        if (unhealthyDeps.length) {
          log(`${name} pending restart — degraded by ${unhealthyDeps.join(', ')}`);
        }
      } else if (unhealthyDeps.length > 0) {
        entry.degradedBy = unhealthyDeps;
      } else {
        delete entry.degradedBy;
      }
    }
  }

  saveState();
}

async function performHealthCheck(name, def) {
  const s = state[name];
  if (!s) return;

  // Skip health check during grace period
  if (Date.now() - s.startedAt < def.startupGraceMs) return;

  const healthy = await checkServiceHealth(name);
  if (healthy) {
    if (!s.healthy) log(`${name} HEALTHY`);
    s.healthy = true;
    s.failures = 0;
  } else {
    const maxFail = def.maxFailures || 3;
    s.failures = (s.failures || 0) + 1;
    log(`${name} unhealthy (failure ${s.failures}/${maxFail})`);
    if (s.failures >= maxFail) {
      log(`${name} ${maxFail} consecutive failures — restarting`);
      // Kill the actual TCP port owner FIRST, not just our tracked child pid.
      // A stale instance can hold the port while state[] points at a dead or
      // different pid (e.g. after a supervisor restart the real owner gets
      // orphaned from state). Killing only s.child leaves the port taken, so
      // every fresh spawn dies on EADDRINUSE — the suite-mcp restart loop.
      const tcpPorts = TCP_PORTS;
      const port = def.tcpPort || tcpPorts[name];
      if (port) {
        try {
          const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
          const pidMatch = out.match(/(\d+)\s*$/m);
          if (pidMatch) {
            const ownerPid = parseInt(pidMatch[1], 10);
            if (ownerPid && ownerPid !== process.pid && (!s.child || ownerPid !== s.child.pid)) {
              log(`${name}: killing port ${port} owner pid ${ownerPid}`);
              killProcess(ownerPid);
            }
          }
        } catch {}
      }
      // Also kill our tracked child if it's still alive
      if (s.child) killProcess(s.child.pid);

      // And kill any other live instance of THIS service that we found by
      // name.
      //
      // Some services run under a pid the supervisor does not own. alice keeps
      // its own PID lock: the launcher exits the moment it sees another
      // instance is already running, so the pid the supervisor tracked was
      // already dead while the real daemon kept running. Killing only the
      // tracked child left the old instance alive, and the replacement
      // launcher exited immediately because the old instance's lock was still
      // held - so "restart alice" restarted nothing and the supervisor
      // looped on it.
      //
      // The command line is matched before the kill, so a pid that has since
      // been reused by an unrelated process is never touched.
      const scriptArg = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js'));
      if (scriptArg) {
        const needle = scriptArg.replace(/^.*\//, '').toLowerCase();
        for (const row of refreshProcessTable()) {
          if (row.pid === process.pid) continue;
          if (s.child && row.pid === s.child.pid) continue;
          if (!row.cmd.toLowerCase().includes(needle)) continue;
          log(`${name}: killing live instance pid ${row.pid}`);
          killProcess(row.pid);
        }
      }
      // Wait for port to be released before spawning new instance
      if (port) {
        let waited = 0;
        while (waited < 10000) {
          try {
            const inUse = await checkTcpPort('127.0.0.1', port, 500);
            if (!inUse) break;
          } catch {}
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
        if (waited > 0) log(`${name} waited ${waited}ms for port ${port} to be released`);
      }
      delete state[name];
      await startService(name);
    }
  }
}

// ── Boot sequence ────────────────────────────────────────────────────
async function boot() {
  log('===== supervisor booting =====');
  log(`workspace: ${ROOT}`);
  log(`state: ${STATE_FILE}`);
  log(`pid: ${process.pid}`);

  // Check for existing services and adopt them
  const persisted = loadState();
  for (const name of START_ORDER) {
    const existingPid = await findExistingProcess(name);
    if (existingPid) {
      log(`${name} already running (pid ${existingPid}) — adopting`);
      const prev = persisted.services?.[name];
      state[name] = {
        child: null,
        externalPid: existingPid,
        failures: 0,
        // When the service ACTUALLY started, not when this supervisor booted.
        //
        // The startup grace period exists so that a service the supervisor has
        // just SPAWNED is not judged before it has finished booting - graytech
        // loads a face-recognition model and needs ~95s, the relay needs 90s.
        // An ADOPTED service was already up before this supervisor existed,
        // so it does not need the grace again.
        //
        // Resetting startedAt to now gave every adopted service the full
        // grace period again, and `healthy` was hard-coded to false until it
        // expired. For the first minute and a half after every supervisor
        // restart, the state file said every single service in the stack was
        // DOWN - including the ones that had never stopped running.
        startedAt: prev?.startedAt || Date.now(),
        // Carry the last known verdict forward. "Not checked yet" is not the
        // same claim as "known to be down", and writing the latter turned a
        // supervisor restart into a stack-wide false alarm.
        healthy: prev?.healthy === true,
        isExternal: true,
      };
    }
  }

  saveState();
  writePid();
  log(`${Object.keys(state).length} services adopted, ${START_ORDER.length - Object.keys(state).length} to start`);
}

// ── Daemon loop ──────────────────────────────────────────────────────
async function daemonLoop() {
  log('daemon mode; polling every 30s');
  let cycle = 0;
  while (!shuttingDown) {
    cycle++;
    log(`=== TICK ${cycle} starting ===`);
    try {
      await tick();
      // Self-prune duplicates each tick so repeated launches can't accumulate
      // a double-relay / triple-MCP memory leak. Runs after tick so the keeper
      // selection reflects the freshly-adopted/started processes.
      try { pruneDuplicateProcesses(); } catch (pe) { log(`self-prune ERROR: ${pe.message}`); }
    } catch (e) { log(`TICK ${cycle} ERROR: ${e.stack || e.message}`); }
    log(`=== TICK ${cycle} done, sleeping 30s ===`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// ── Daemonize (Windows-friendly self-detach) ─────────────────────────
function daemonize() {
  // Guard against piling up duplicate --serve supervisors. Every --daemon
  // invocation used to spawn a fresh --serve child unconditionally, so the
  // three boot scripts (start-everything.bat, start-supervisor.bat, and the
  // Vex-Supervisor logon task) each left a long-lived daemon behind →
  // 5+ supervisors fighting over the same state file. Check the lock first:
  if (!acquireLock()) {
    log(`daemonize: another supervisor is already running (PID lock held) — refusing to spawn duplicate`);
    console.log('Supervisor already running — no duplicate spawned');
    process.exit(0);
  }
  releaseLock(); // hand the lock to the child we're about to spawn
  log('daemonizing...');
  const child = spawn(process.execPath, [process.argv[1], '--serve'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(`daemon child pid: ${child.pid}`);
  console.log(`Supervisor daemon started (pid ${child.pid})`);
  process.exit(0);
}

// ── PID lock ─────────────────────────────────────────────────────────
/**
 * Pids of node processes running this supervisor in --serve mode.
 *
 * The pid file is only a hint: it can be emptied by a restart, truncated by a
 * crash, or left behind by a killed supervisor. Two live supervisors over one
 * state file are worse than none - they fight over the service list, and each
 * one's startup sweep treats the other's children as stale owners.
 */
function findRunningServeSupervisors() {
  try {
    const out = execSync(
      `wmic process where "name='node.exe' and commandline like '%supervisor.mjs%' and commandline like '%--serve%'" get processid /format:csv`,
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8', windowsHide: true }
    );
    return out.trim().split(/\r?\n/)
      .filter(l => /,\d+\s*$/.test(l))
      .map(l => parseInt(l.split(',').pop().trim(), 10))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function acquireLock() {
  try {
    if (existsSync(PID_FILE)) {
      const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      if (oldPid && isProcessRunning(oldPid)) {
        return false; // another supervisor is running
      }
    }
    // The pid file alone is not proof. Look for a live --serve supervisor
    // before taking the lock, so a stale or cleared pid file cannot let a
    // second supervisor start on top of a running one.
    const others = findRunningServeSupervisors().filter(p => p !== process.pid);
    if (others.length > 0) {
      log(`acquireLock: a --serve supervisor is already running (pid ${others[0]}) — refusing to start a second`);
      return false;
    }
    writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch {
    return true; // if we can't read/write the lock, proceed anyway
  }
}

function releaseLock() {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      if (pid === process.pid) writeFileSync(PID_FILE, '');
    }
  } catch {}
}

// ── Main ─────────────────────────────────────────────────────────────
/**
 * Every descendant of the given pids.
 *
 * A supervised service is often a WRAPPER whose child owns the port. `pg` is
 * `relay/start-pg.mjs`; it spawns postgres.exe as its child, and postgres.exe
 * is the real listener on :5432. The state file tracks the wrapper's pid, so
 * the port owner was never in the tracked set and the startup sweep treated
 * postgres.exe as a stale owner and killed the database — on every single
 * supervisor restart. Preserving the whole subtree of every tracked pid
 * fixes it without weakening the sweep for anything else.
 */
function collectDescendantPids(rootPids) {
  const descendants = new Set();
  if (!rootPids || rootPids.size === 0) return descendants;
  try {
    const out = execSync('wmic process get ProcessId,ParentProcessId /format:csv', {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    const byParent = new Map();
    for (const line of out.split(/\r?\n/)) {
      // CSV header is "Node,ParentProcessId,ProcessId"
      const m = line.trim().match(/^[^,]*,(\d+),(\d+)\s*$/);
      if (!m) continue;
      const parent = parseInt(m[1], 10);
      const pid = parseInt(m[2], 10);
      if (!Number.isInteger(parent) || !Number.isInteger(pid)) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(pid);
    }
    const queue = [...rootPids];
    while (queue.length) {
      const pid = queue.pop();
      for (const child of byParent.get(pid) || []) {
        if (descendants.has(child)) continue;
        descendants.add(child);
        queue.push(child);
      }
    }
  } catch {}
  return descendants;
}

/**
 * Kill every stale owner of a supervised port at daemon start.
 *
 * Windows allows two sockets to bind the same port when SO_REUSEADDR is set,
 * and netstat then lists both. When this daemon is killed and relaunched, the
 * `py` launcher it spawned survives as an orphan and keeps the port, so the
 * freshly started service load-balances against stale code. That is not a
 * visible failure: requests appear to work, they just answer from the old
 * build about half the time. It has twice cost an hour of debugging a "fix that
 * did not take effect".
 *
 * Only ports this supervisor owns are touched, and the daemon's own pid is
 * never a candidate.
 */
function sweepStalePortOwners() {
  // pids of services this supervisor is already tracking, which must survive
  // the sweep. Read fresh from the state file: a restarted daemon has no
  // in-memory children yet, but the previous run's pids are still recorded.
  //
  // loadState() nests service entries under `.services`. Reading the top level
  // instead finds nothing, and the sweep then kills every live service — which
  // it did, taking Postgres with it.
  const trackedChildPids = new Set();
  const persisted = loadState() || {};
  const entries = persisted.services && typeof persisted.services === 'object'
    ? Object.entries(persisted.services)
    : [];
  for (const [, entry] of entries) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['childPid', 'externalPid', 'pid']) {
      const pid = Number(entry[key]);
      if (Number.isInteger(pid) && pid > 0) trackedChildPids.add(pid);
    }
  }
  log(`startup sweep: ${trackedChildPids.size} tracked child pid(s) to preserve`);

  // A tracked service may be a wrapper whose CHILD owns the port (pg ->
  // start-pg.mjs -> postgres.exe on :5432). Preserve the whole subtree, or the
  // sweep kills the database every time the supervisor restarts.
  const descendantPids = collectDescendantPids(trackedChildPids);
  if (descendantPids.size > 0) {
    log(`startup sweep: ${descendantPids.size} descendant pid(s) of tracked services preserved`);
    for (const pid of descendantPids) trackedChildPids.add(pid);
  }

  // With no record of what we own, killing listeners is a guess. Refuse rather
  // than take the whole stack down on a bad state file.
  if (trackedChildPids.size === 0) {
    log('startup sweep: no tracked pids found — skipping sweep to avoid killing live services');
    return;
  }

  const ports = new Set();
  for (const def of SERVICE_DEFS) {
    if (def.tcpPort) ports.add(def.tcpPort);
  }
  // Ports the daemon monitors but which are not in SERVICE_DEFS.
  for (const port of [5432, 54321, 8080, 5173, 3120, 3121, 3080, 5175, 5174, 38401]) {
    ports.add(port);
  }

  for (const port of ports) {
    let out = '';
    try {
      out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, {
        encoding: 'utf8', timeout: 5000,
      });
    } catch { continue; }

    // Every pid, not just the first: with two bound sockets there are two.
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) pids.add(parseInt(m[1], 10));
    }
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      // `state` is keyed by service name, not pid, so the tracked children have
      // to be collected explicitly. Killing one of our own live services here
      // would be a self-inflicted outage.
      if (trackedChildPids.has(pid)) continue;
      try {
        log(`startup sweep: killing stale pid ${pid} on port ${port}`);
        killProcess(pid);
      } catch (e) {
        log(`startup sweep: could not kill pid ${pid} on port ${port}: ${e.message}`);
      }
    }
  }
}

async function main() {
  const mode = process.argv.includes('--once') ? 'once'
    : process.argv.includes('--serve') ? 'serve'
    : process.argv.includes('--daemon') ? 'daemon'
    : process.argv.includes('--status') ? 'status'
    : 'serve';  // default: foreground serve

  // A deliberate stop has to stick. The watchdog task that restarts a dead
  // supervisor would otherwise undo it within a tick, and "stop" would be a
  // button that flashes and lies.
  if (mode === 'daemon' || mode === 'serve') {
    if (existsSync(DISABLED_FILE)) {
      log('supervisor is disabled (relay-data/supervisor.disabled exists) — not starting');
      process.exit(0);
    }
  }

  if (mode === 'daemon') {
    daemonize();
    return;
  }

  if (mode === 'status') {
    const st = loadState();
    console.log(JSON.stringify({ pid: process.pid, supervisor: st._pid, alive: !!st._pid, ...st }, null, 2));
    return;
  }

  // Clear orphaned listeners before anything adopts or starts a service.
  if (mode === 'serve') {
    try { sweepStalePortOwners(); } catch (e) {
      log(`startup sweep failed: ${e.message}`);
    }
  }

  // For --once mode: skip if a --serve daemon is already running
  if (mode === 'once') {
    if (existsSync(PID_FILE)) {
      try {
        const servePid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
        if (servePid && isProcessRunning(servePid)) {
          // A --serve daemon is active — let it handle everything
          return;
        }
      } catch {}
    }
    // No daemon running — proceed with one-shot tick
    // Load persistent failure counts from state file
    const persistentState = loadState();
    for (const name of START_ORDER) {
      const saved = persistentState.services?.[name];
      if (saved && typeof saved.failures === 'number') {
        state[name] = state[name] || {};
        state[name].failures = saved.failures;
        state[name].startedAt = saved.startedAt || Date.now();
        state[name].healthy = saved.healthy || false;
      }
    }
    await boot();
    await tick();
    log('===== one-shot done =====');
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // serve mode — foreground daemon
  if (!acquireLock()) {
    log('another supervisor is already running (PID lock held) — exiting');
    process.exit(0);
  }
  process.on('SIGINT', () => { shuttingDown = true; stopAll(); releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { shuttingDown = true; stopAll(); releaseLock(); process.exit(0); });
  process.on('unhandledRejection', (reason) => {
    log(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
  });

  await boot();
  await daemonLoop();
}

main().catch((e) => { log(`FATAL: ${e.stack}`); process.exit(1); });
