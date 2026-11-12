# XMRT Ecosystem

**The XMRT ecosystem — a supervised process stack providing a fleet relay, local Supabase-compatible runtime, Postgres, Cloudflare tunnel, fleet agents, and the XMRT Suite dashboard.**

**Live Relay:** [relay.mobilemonero.com](https://relay.mobilemonero.com) · **Suite Dashboard:** [suite.mobilemonero.com](https://suite.mobilemonero.com)

---

## What this repository contains

This repository contains the full XMRT ecosystem stack:

- **`relay/`** — The fleet relay server (Express, port 8080). 213+ tools, fleet chat, task management, harness registry, AI cascade (26 providers), TrustGraph scoring, email integration, and supervised process management.
- **`local-supabase/`** — local-sb, a drop-in Supabase replacement (PostgREST-compatible REST, Deno edge functions, auth, storage). Runs on Node + Deno + Postgres, zero Docker.
- **`suite/`** — XMRT Suite SPA (React/Vite). The operator's cockpit: Unified Chat with Eliza, Agent & Task Visualizer, mining/DAO tooling, memory & learning.
- **`scripts/`** — Utility scripts (encoding checks, migrations, etc.)
- **`docs/`** — Documentation and brand guides.

## Quick Start

See [relay/README](relay/README.md) and [suite/README.md](suite/README.md) for detailed installation instructions.

### Prerequisites (Linux)

- Node.js 20+
- PostgreSQL 15+
- Deno 1.x+
- Git
- Ollama (optional, for local LLM inference)

### Start the stack

```bash
# Clone
git clone https://github.com/xmrtdao/mobilemonero.git
cd mobilemonero

# Install
cd relay && npm install && cd ..
cd local-supabase && npm install && cd ..
cd suite && npm install --legacy-peer-deps && cd ..

# Configure
cp relay/.env.example relay/.env
cp suite/.env.example suite/.env.local
# Edit both .env files with your API keys

# Start
node supervisor.mjs --serve

# Verify
curl http://localhost:8080/health
```

## Repository Layout

- `relay/` — Fleet relay server, tools, migrations, cron engine
- `local-supabase/` — Supabase-compatible local runtime
- `suite/` — XMRT Suite dashboard (React SPA)
- `scripts/` — Utility scripts
- `docs/` — Documentation

## Related Repositories

- **[xmrtdao/suite](https://github.com/xmrtdao/suite)** — XMRT Suite frontend (standalone)
- **[xmrtdao/mobilemonero](https://github.com/xmrtdao/mobilemonero)** — Relay + local-sb + supervisor
- **[xmrtdao/jobbymcjobberson](https://github.com/xmrtdao/jobbymcjobberson)** — Jobby McJobberson job search engine (separate project)
- **[xmrtdao/cashdapp](https://github.com/xmrtdao/cashdapp)** — CashDapp payments platform (separate project)

## License

MIT