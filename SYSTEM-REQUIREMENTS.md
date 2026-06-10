# System Requirements & Service Map

**Generated:** 2026-06-10 (sweep)
**Repo:** `C:\Users\PureTrek\Desktop\DevGruGold`
**Host:** PURETREK (Windows, single-machine stack)
**User:** Joe / PFP → mobilemonero.com / XMRT DAO

This file is the canonical answer to **"what does our system need to be running to function correctly?"** Update it whenever services, ports, or supervisors change.

---

## 1. Runtime Stack (all required)

| Runtime | Version | Where | Why |
|---|---|---|---|
| Node.js | >= 18 (engines in `relay/package.json`) | `C:\Program Files\nodejs\node.exe` | Relay, Vite, all `.mjs` daemons, cron-engine-v2, alice, daily-campaign |
| Deno | bundled `1.x` | `bin\deno\deno.exe` | Edge function runtime used by local-sb at port 54321 |
| Postgres | bundled `18.x` (embedded) | `pg/` | Backing store for local-sb, fleet, tasks, etc. |
| PostgREST | bundled | `bin\postgrest\postgrest.exe` | Standby (currently not active; local-sb implements its own PostgREST-compatible router) |
| Ollama | `ollama.exe serve` | `C:\Users\PureTrek\AppData\Local\Programs\Ollama\` | Local LLM (14 models); primary AI provider |
| cloudflared | bundled | `cloudflared.exe` | Named tunnel `5d954e14-...` for `relay.mobilemonero.com`, `inbox.partyfavorphoto.com`, `inbox.mobilemonero.com` |
| LibreOffice/ImageMagick/etc. | optional | — | Only for `tools/` pdf/excel scripts — not on the critical path |

> **Anything else on this machine is noise.** If a service is not in §2, it does not need to be running.

---

## 2. Active Services & Ports

All services run on `localhost` only. Public access is via cloudflared tunnel.

| Port | Service | PID (as of sweep) | Started | Owner | Health |
|---|---|---|---|---|---|
| **5432** | `postgres.exe` (local PG) | 9604 | 6/9 21:18 | supervisor (pg slot, `wrapperExits:true`) | `pg_isready` |
| **8080** | `relay/server.js` (Eliza-Dev) | 3704 | 6/10 14:33 | supervisor | `GET /health` → `{"status":"ok",...}` |
| **5173** | Vite dev server (SupaClaw) | 476 | 6/9 20:45 | manual `npm run dev` | `GET /` → HTML |
| **54321** | `local-supabase/server.mjs` (drop-in Supabase) | 8608 | 6/10 15:04 | manual `node --watch` (NOT supervisor) | `GET /` → `{"name":"local-supabase"...}` |
| **11434** | `ollama.exe serve` | 10588 | 6/9 18:58 | background | `GET /api/tags` → 14 models |
| **20241** | cloudflared named tunnel (metrics port, `localhost`) | 10084 | 6/9 21:08 | supervisor (tunnel slot) | `GET /health` returns 404 (no metrics) — verify via public hostname instead |
| **42050** | OneDrive sync (system, ignore) | — | — | OS | — |
| **49722** | Ollama helper (system, ignore) | — | — | OS | — |
| **49963, 49956, 49957** | Node 11432 (orphan shell, empty `node.exe`) | 11432 | 6/9 (stale) | unknown wrapper | INERT — can be killed, will respawn only if something else spawns it |
| **61687** | llama-server (Ollama subprocess, ignore) | 5560 | 6/10 14:06 | Ollama | — |

### Public hostnames (via cloudflared tunnel)

| Hostname | Backend | Status (sweep) |
|---|---|---|
| `https://relay.mobilemonero.com` | relay `:8080` | 200 |
| `https://inbox.partyfavorphoto.com` | relay `:8080` | 200 |
| `https://inbox.mobilemonero.com` | relay `:8080` | 200 |
| `https://hermes.mobilemonero.com` | Hermes phone (off-host) | fleet:agents reports online |

---

## 3. Daemons (long-running processes, NOT a port)

| Daemon | PID | Started | Supervised by | Restart policy |
|---|---|---|---|---|
| `node relay/supervisor.mjs --daemon` (Vex) | 11960 | 6/10 14:01 | Windows logon task (manual) | n/a — supervises others |
| `node relay/campaign-scheduler.mjs --daemon` | 6972 | 6/10 15:29 | supervisor | max 4/hr |
| `node relay/alice.mjs --daemon` | 9284 | 6/10 14:06 | supervisor (alice slot, `wrapperExits:true`) | max N/hr |
| `node relay/cron-engine-v2.mjs` (cron loop) | 12172 | 6/10 08:04 | NOT supervised by supervisor (orphan from 8am scheduled task) | none — restart manually if dies |
| `cloudflared tunnel run` | 10084 | 6/9 21:08 | supervisor (tunnel slot, `wrapperExits:true`) | max 3/hr |

> **Risk:** `cron-engine-v2` is NOT supervised. If it dies, no one respawns it. Recommend adding it to `supervisor.mjs` SERVICES list.
> **Risk:** `local-sb` (PID 8608) was started manually with `node --watch` — its supervisor slot still points to the dead PID 6652 from the 6/10 14:51 attempt. The HTTP health probe passes, so the supervisor doesn't notice the swap. This is safe but the supervisor-state will be permanently stale for that slot.

---

## 4. Scheduled Tasks (Windows Task Scheduler)

### Active (supervisor duplicates; harmless but legacy)

| Task | Action | Last run | State |
|---|---|---|---|
| `XMRT-DAO-4PMCampaign` | `daily-campaign.mjs 50` | 6/9 16:00 | **Ready** (next 6/10 16:00) |
| `XMRT-DAO-DailyCampaign` | `daily-campaign.mjs 50` | 6/10 08:00 | Ready (next 6/11 08:00) |
| `XMRT-DAO-NoonCampaign` | `daily-campaign.mjs 50` | 6/10 12:00 | Ready (next 6/11 12:00) |
| `XMRT-DAO-SeasonalScraper` | `seasonal-scraper.mjs` | 6/9 23:00 | Ready (next tonight 23:00) |

### Disabled (already off)

`XMRT-DAO-2PMCampaign`, `XMRT-DAO-6PMCampaign`, `XMRT-DAO-8PMCampaign`, `XMRT-DAO-10PMCampaign`

### Stale (Ready, but no longer firing — supersede by `campaign-scheduler.mjs` daemon)

| Task | Action | Last run | Days dead | Recommendation |
|---|---|---|---|---|
| `XMRT-DAO-HourlyTaskFetch` | `cron-fetch-tasks.mjs --once` | **2026-05-11 22:00** | **30** | **Delete** (superseded by `relay/alice.mjs --daemon` task-fetch) |
| `XMRT-DAO-HourlyTaskFetch-v2` | `cron-fetch-tasks.mjs --once` | **2026-06-02 23:10** | **8** | **Delete** (same) |
| `XMRT-Relay-Watchdog` | `relay-watchdog.mjs` | **2026-06-02 12:30** | **8** | **Delete** (superseded by `relay/supervisor.mjs`) |
| `VexSupervisor-Heartbeat` | `suite/runtime/supervisor/heartbeat.cmd` | **2026-06-08 23:50** | **2** | **Delete or investigate** (suite runtime is dead) |

> **Cleanup action needed:** 4 stale Windows tasks should be removed. They do no harm (they don't fire on their own without an admin trigger), but they pollute `schtasks /query` and the supervisor's `lastTaskResults` reads them as `Ready` so any future alert logic will be confused.

---

## 5. External Dependencies

### Email (Resend)

| Account | Key prefix | Verified domain | From address | Used by |
|---|---|---|---|---|
| PFP (primary) | `re_BrGV9sSL_...` | `partyfavorphoto.com` (verified, sending+receiving) | `Party Favor Photo <bookings@partyfavorphoto.com>` → reply `joe@partyfavorphoto.com` | `daily-campaign.mjs` (fixed 6/10) |
| XMRT (secondary) | `re_8ypZddMZ_...` | `mobilemonero.com` (partially_failed) | various | NOT currently used by PFP code |

**Rate limit:** 5 req/s. `daily-campaign.mjs` now paces at 250ms with 429 retry.

### Stripe
No `STRIPE_SECRET_KEY` in `relay/.env` (PFP booking links in campaign template are hardcoded `https://buy.stripe.com/...` URLs). Stripe key is in `relay/tools/` scripts only — not on the critical path.

### GitHub
`GITHUB_TOKEN=github_pat_...` in `relay/.env`. Used by tools for repo operations and the gh-deploy workflows.

### Supabase
- **Cloud:** `vawouugtzwmejxqkeqqj.supabase.co` is **DEAD** (NXDOMAIN). Most code paths still reference it for legacy reasons. **Do not re-enable** — kept commented in `relay/.env`.
- **Local:** `local-supabase/server.mjs` on `:54321` is the canonical replacement. All `relay/server.js` endpoints route here.

### Cloudflare
- **Tunnel:** `5d954e14-ea46-48e4-bc50-9c3a2be1760c` (named tunnel, 3 hostnames — see §2).
- **Workers:** 17 workers in `cf-workers.json` (all routed).
- **Access service tokens:** 3 agents (Eliza, Vex, Hermes) in `relay/.env` as `CF_ACCESS_CLIENT_*`.

### AI providers (in fallback chain)
1. **Local Ollama** (priority 1) — `OLLAMA_HOST=http://localhost:11434`, `OLLAMA_MODEL=deepseek-v4-flash:cloud` (default; cloud-routed)
2. Ollama Pro — `OLLAMA_API_KEY`
3. DeepSeek — `DEEPSEEK_API_KEY=sk-...`
4. Gemini — `GEMINI_API_KEY=AQ.Ab8R...` (looks like OAuth token, verify before relying)
5. Kimi — `KIMI_API_KEY=sk-kimi-...` (placeholder-looking; verify)
6. OpenRouter — `OPENROUTER_API_KEY=` (empty)
7. (Ollama `LOCAL_OLLAMA_ONLY=1` is set — probably misnamed; double-check before relying on cloud fallback)

### Other
- **Hermes endpoint** (Android phone agent): `HERMES_ENDPOINT=http://192.168.14.115:9090` — must be reachable on LAN for Alice/relay integrations.
- **MUAPI** (video gen): `MUAPI_API_KEY` — balance reported $10.012 by Alice.

---

## 6. .env Key Inventory (relay/.env)

All keys present and correct as of 2026-06-10. **SUSPICIOUS / VERIFY:**

- `GEMINI_API_KEY=AQ.Ab8R...` — OAuth/refresh token format, not a standard API key. Verify it actually authorizes Gemini API calls.
- `KIMI_API_KEY=sk-kimi-...` — same prefix as the suspicious "identical" keys noted in the .env comment. Verify.
- `OPENROUTER_API_KEY=` — empty. If code paths reference it, they will fail.
- `LOCAL_OLLAMA_ONLY=1` — flag is set to true. Name suggests "no cloud fallback" but value is `1`. Read consumers before changing.

---

## 7. Boot Order (what depends on what)

If everything is dead, restart in this order:

1. **Postgres** (`pg/`) — must be up before local-sb. Verify: `pg_isready -h 127.0.0.1 -p 5432`
2. **local-sb** (`local-supabase/`, port 54321) — depends on Postgres. Verify: `curl http://127.0.0.1:54321/`
3. **Ollama** (port 11434) — independent, but relay + Alice depend on it. Verify: `curl http://127.0.0.1:11434/api/tags`
4. **Vite** (port 5173) — independent dev server. `cd suite && npm run dev` (only needed if Joe is editing the SupaClaw UI)
5. **Relay** (`relay/server.js`, port 8080) — depends on local-sb + Postgres. Verify: `curl http://localhost:8080/health`
6. **cloudflared** (named tunnel) — depends on Relay for `/health` to be reachable publicly. Verify: `curl https://relay.mobilemonero.com/health`
7. **Alice daemon** (`relay/alice.mjs --daemon`) — depends on Relay. Run via supervisor.
8. **Campaign scheduler** (`relay/campaign-scheduler.mjs --daemon`) — depends on Relay + Resend. Run via supervisor.
9. **Cron-engine-v2** (`relay/cron-engine-v2.mjs`) — depends on Postgres + local-sb. **Manual start** (not supervised): `node relay/cron-engine-v2.mjs`. Should be backgrounded with `--watch` or moved under supervisor.
10. **Supervisor** (`relay/supervisor.mjs --daemon`) — should already be running at logon. If not: `node relay/supervisor.mjs --daemon`.

### One-liner health check (post-boot)

```bash
curl -sf http://localhost:8080/health && \
curl -sf http://127.0.0.1:54321/ && \
curl -sf -o /dev/null -w "%{http_code}\n" http://127.0.0.1:11434/api/tags && \
curl -sf -o /dev/null -w "%{http_code}\n" https://relay.mobilemonero.com/health
```

All four should return 200.

---

## 8. Quick-Reference Restart Commands

| Service | Restart |
|---|---|
| Postgres | `node relay/start-pg.mjs` (or supervisor does it) |
| local-sb | `cd local-supabase && node --watch server.mjs` (manual) |
| Relay | supervisor restarts; or `node relay/server.js` |
| Ollama | start from Start menu (system service) |
| Vite | `cd suite && npm run dev` |
| cloudflared | supervisor restarts; or `cloudflared tunnel --config C:\Users\PureTrek\.cloudflared\config.yml run` |
| Alice | supervisor restarts; or `node relay/alice.mjs --daemon` |
| Campaign scheduler | supervisor restarts; or `node relay/campaign-scheduler.mjs --daemon` |
| Cron-engine-v2 | **manual only**: `node relay/cron-engine-v2.mjs` |

---

## 9. Known Issues / Follow-ups

- **Cron-engine-v2 not in supervisor.** Add it as a service in `relay/supervisor.mjs` SERVICES list.
- **local-sb PID mismatch.** Supervisor slot `local-sb` is stuck on dead PID 6652. Either fix supervisor to re-spawn OR delete the slot.
- **Stale Windows tasks.** 4 tasks (`XMRT-DAO-HourlyTaskFetch`, `-v2`, `XMRT-Relay-Watchdog`, `VexSupervisor-Heartbeat`) should be deleted via `schtasks /delete`.
- **Alice task-fetch uses dead cloud URL.** `alice.mjs` still tries to fetch tasks from `vawouugtzwmejxqkeqqj.supabase.co` — should point at `LOCAL_RUNTIME_URL`.
- **Suspicious API keys** in .env: Gemini, Kimi, OpenRouter (empty). Verify before relying.
- **`doorman-worker/src/index.js:9` and `cloudflare-workers/*` still reference the dead cloud Supabase URL** — out of scope for relay, but they will 502 if hit.
- **Vite dev server is up but not in supervisor.** Will not auto-restart on crash.
- **PostgREST** (`bin/postgrest/`) is bundled but inactive. local-sb implements its own. Leave as-is.

---

## 10. Files That MUST Exist (kill-switch map)

If any of these files are missing or empty, the corresponding service will silently fail:

| File | Required for |
|---|---|
| `relay/.env` | Relay, Alice, daily-campaign, cron-engine-v2 |
| `local-supabase/server.mjs` | local-sb |
| `bin/deno/deno.exe` | local-sb edge functions |
| `bin/postgrest/postgrest.exe` | (optional, not active) |
| `~/.cloudflared/5d954e14-...json` | named tunnel credentials |
| `~/.cloudflared/config.yml` | named tunnel config (3 hostnames) |
| `relay-data/campaign-contacts.json` | daily-campaign (8796 contacts as of sweep) |
| `relay-data/campaign-sent.json` | dedup + 30-day window |
| `relay-data/suppression-list.json` | do-not-contact list |
| `pg/data/` (postgres cluster) | everything that touches local DB |
