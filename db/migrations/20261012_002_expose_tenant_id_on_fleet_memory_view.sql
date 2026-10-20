-- ============================================================================
-- Expose tenant_id through public.fleet_memory
-- Task: 206832ed-c737-4118-831e-35bf2e6545da ("Expose tenant_id on
--        public.fleet_memory view (multi-tenancy blocker)")
-- Created: 2026-10-12
--
-- VERIFIED STATE BEFORE THIS MIGRATION (read-only inspection):
--   app.fleet_memory     HAS tenant_id uuid NULLABLE, no default
--   public.fleet_memory  is a VIEW and does NOT expose tenant_id at all
--   existing rows:       3,208 with tenant_id = 00000000-...-0000 (all-zero)
--                        731 with tenant_id IS NULL
--                        total 3,939 rows, 0 null agent_id, 9 distinct agents
--
-- WHY IT MATTERS:
--   Every memory the relay and MCP layers read goes through the view, so any
--   row written that way is unpartitionable by tenant. That blocks per-customer
--   data-residency proof, clean single-org audit exports, per-tenant retention
--   and deletion, and data-subject deletion without a full-table purge.
--   Retrofitting partition keys after customer data exists is expensive; the
--   migration is cheap now.
--
-- FORWARD-ONLY. Does not drop or recreate app.fleet_memory. Per the task's
-- own DO NOT clause.
--
-- SAFE TO RE-RUN.
-- ============================================================================

-- ── 1. Backfill before the constraint, so nothing is left unassigned ───
-- The all-zero UUID is already a de-facto sentinel in 3,208 rows; NULL in 731.
-- Normalise NULL -> the same all-zero sentinel so there is exactly ONE
-- well-defined legacy value rather than two ambiguous ones.
--
-- Deliberately NOT defaulting to a made-up tenant id like 'unknown': the task
-- says that would recreate the same unpartitionable-rows problem at larger
-- scale. The all-zero UUID is a recognised, obviously-not-a-tenant value, so
-- "these rows are unassigned" stays an explicit, countable state.
UPDATE app.fleet_memory
   SET tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 WHERE tenant_id IS NULL;

-- ── 2. Make tenant_id mandatory going forward ────────────────────
-- Nullable + no default is what let 731 rows drift in the first place. A new
-- row with no tenant is exactly the unpartitionable row we are preventing.
-- The default keeps existing INSERT paths that do not name a column working;
-- they land on the sentinel rather than on NULL.
ALTER TABLE app.fleet_memory
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid;

ALTER TABLE app.fleet_memory
  ALTER COLUMN tenant_id SET NOT NULL;

COMMENT ON COLUMN app.fleet_memory.tenant_id IS
  'Owning tenant. NOT NULL: a memory that cannot be attributed to a tenant '
  'cannot be exported, retained, or deleted per-tenant, so it is not allowed '
  'to exist. The all-zero UUID means "not yet assigned to a real tenant" and '
  'is the explicit legacy/unassigned marker, not a real tenant.';

-- ── 3. Record provenance rather than papering over attribution gaps ───
-- Pairs with tasks 4fbadf43 / ca888784. Those are about agent_id being NULL
-- on the write path. If a write ever lands with a sentinel or missing
-- attribution we want that visible in the row itself, not inferred later.
ALTER TABLE app.fleet_memory
  ADD COLUMN IF NOT EXISTS write_source TEXT;

COMMENT ON COLUMN app.fleet_memory.write_source IS
  'Which path wrote this row (e.g. relay:fleet_memory_write, mcp, migration '
  'backfill). Lets attribution failures be recorded as provenance instead of '
  'being hidden behind a sentinel agent id.';

UPDATE app.fleet_memory
   SET write_source = 'migration:tenant_backfill'
 WHERE write_source IS NULL
   AND tenant_id = '00000000-0000-0000-0000-000000000000'::uuid;

-- ── 4. Re-expose the view WITH tenant_id (and write_source) ───────
-- CREATE OR REPLACE VIEW is only permitted when the new definition keeps the
-- existing columns in the same order and adds new ones at the end. That is
-- exactly what this does, so every current reader of public.fleet_memory keeps
-- working without change.
CREATE OR REPLACE VIEW public.fleet_memory AS
    SELECT id,
           agent_id,
           agent_role,
           memory_type,
           scope,
           title,
           body,
           payload,
           refs,
           confidence,
           ttl_at,
           created_at,
           updated_at,
           tenant_id,
           write_source
      FROM app.fleet_memory;

COMMENT ON VIEW public.fleet_memory IS
  'Read path used by the relay and MCP layers. Exposes tenant_id so memories '
  'are partitionable per customer. Every underlying column is NOT NULL; '
  'information_schema reports view columns as nullable because views do not '
  'carry base-table constraints — resolve constraints against app.fleet_memory.';

-- ── 5. Index the tenant column ───────────────────────────────────
-- Any per-tenant query (residency proof, audit export, retention, deletion)
-- filters on this. Without it every one of those is a sequential scan of 3,939
-- rows today and of the whole table tomorrow.
CREATE INDEX IF NOT EXISTS idx_app_fleet_memory_tenant
  ON app.fleet_memory(tenant_id);

-- Partial index for the "unassigned" backlog: lets us count and work down
-- rows that still need a real tenant without scanning assigned rows.
CREATE INDEX IF NOT EXISTS idx_app_fleet_memory_unassigned
  ON app.fleet_memory(created_at)
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid;