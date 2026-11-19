# OpenProject Integration Plan — XMRT Task Pipeline

**Status:** Design + partial implementation. Phase 1 (DB unification) executed 2026-11-19.
**Owner:** Fleet (Hermes to execute infra, Vex to wire relay endpoints)

## Why

The XMRT fleet has multiple task stores (app.tasks canonical, public.agent_tasks retired, agent.agent_tasks retired, cuttlefish_agent_tasks specialized). The vault note `task-pipeline-migration-schema-2026-11-19.md` and `Schema Migration Plan.md` document the fragmentation. OpenProject (cloned at `openproject/`) is the chosen consolidation UI — it must point at `app.tasks` only, after unification.

## Current state (validated 2026-11-19)

- `app.tasks` is canonical: 511 rows, 22 cols, FK anchor (task_escalations, task_artifacts, task_confirmations).
- `public.tasks` is a VIEW over `app.tasks` (19 cols) — backward compat, keep.
- `public.agent_tasks` (2 rows) MIGRATED into `app.tasks` (metadata JSONB holds depends_on/parent_task_id/result). Retired as `public.agent_tasks_retired_20261119`.
- `agent.agent_tasks` (0 rows) retired as `agent.agent_tasks_retired_20261119`.
- `public.cuttlefish_agent_tasks` (27 rows) kept — specialized, separate shape.
- `public.app__tasks`, `public.agent__agent_tasks` views intact.
- No OpenProject integration exists yet (no references in relay/ or suite/src).
- OpenProject is NOT running (no service on 3000/8081). It is a full Rails app requiring Ruby, Postgres (its own DB `openproject`), migrations, and an API token.

## Phase 1 — DB unification ✅ DONE (2026-11-19)

- Backup: `backups/task_pipeline_backup_2026-11-19.json`
- Migrated 2 agent_tasks rows into app.tasks (metadata JSONB).
- Retired agent.agent_tasks + public.agent_tasks (renamed, preserved).
- app.tasks now sole live pipeline (511 rows).

## Phase 2 — Code references ✅ DONE

- cuttlefishclaws-mcp.mjs only listed cuttlefish_agent_tasks (kept, specialized) — no change needed.
- No other code references public.agent_tasks or agent.agent_tasks.

## Phase 3 — OpenProject integration (DESIGN + partial impl)

### Architecture
- OpenProject runs as a separate service (Ruby/Rails, port 3000, its own DB `openproject`).
- Relay gets a thin REST v3 client: `relay/lib/openproject.mjs` (✅ created, syntax-checked).
  - opHealth, opListProjects, opListTypes, opListStatuses, opListWorkPackages, opCreateWorkPackage, opUpdateStatus.
- Sync direction: XMRT `app.tasks` → OpenProject work packages (one-way push; OpenProject is the UI).
- Mapping: app.tasks.title → subject, description → description, priority → priority, status → status (via OpenProject statuses), assignee_agent_id → assignee (via user mapping), metadata → custom fields.

### Relay endpoints to add (next)
- `GET  /api/openproject/health` — connectivity check (uses opHealth).
- `GET  /api/openproject/projects` — list target projects.
- `POST /api/openproject/sync-task` — push one app.tasks row → OpenProject work package; store the returned work package id back into app.tasks.metadata.openproject_wp_id.
- `POST /api/openproject/sync-all` — bulk push (admin, low-activity window).

### Suite UI
- Add a "Tasks" view in Suite that reads app.tasks via the existing relay API (already wired through UnifiedChat/task tools).
- Add an "Open in OpenProject" link per task (using the stored wp id).
- No direct DB access from Suite — always through relay.

### OpenProject setup (ops, not yet done)
1. Install Ruby 3.3 + bundler; run `bundle install` in openproject/.
2. Create DB `openproject` with user `openproject` (see .env.example).
3. Run migrations: `bin/rails db:migrate`.
4. Create an API token (My account → Access tokens) and set `OPENPROJECT_API_KEY` in relay/.env.
5. Set `OPENPROJECT_URL` in relay/.env (default http://127.0.0.1:3000).
6. Create a project in OpenProject for XMRT tasks; note its id/identifier.
7. Run sync-all once to seed.

### What is NOT in scope
- The 13-domain schema reorg (Schema Migration Plan.md) — separate, high-risk initiative; do not bundle with task unification.
- OpenProject replacing the relay DB — OpenProject is the UI/consolidation layer only; app.tasks remains canonical.

## Phase 4 — Verification
- app.tasks remains sole live pipeline (511+ rows).
- OpenProject health endpoint returns ok once stood up.
- A synced task appears as a work package in OpenProject.

## Next action
Stand up OpenProject (Phase 3 ops) and add the relay endpoints (Phase 3 relay). Until then, the client module `relay/lib/openproject.mjs` is ready and syntax-checked.
"