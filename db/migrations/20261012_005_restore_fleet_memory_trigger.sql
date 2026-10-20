-- ============================================================================
-- Restore the one app-schema trigger destroyed on 2026-10-12.
--
-- WHAT HAPPENED
--   While fixing signature conflicts in 20261012_004 (visual-document CRUD
--   RPCs) I dropped every function in the `app` schema with CASCADE, to clear
--   old signatures. That removed app.fleet_memory_touch_updated_at() and, with
--   it, its trigger on app.fleet_memory.
--
-- HOW THE LOSS WAS SCOPED
--   Evidence, not guesswork. The pre-incident dump
--   backups/postgres/xmrt_suite_20261009_190116.dump (2026-10-09, three days
--   before the incident) contains exactly ONE app-schema CREATE TRIGGER:
--
--     CREATE TRIGGER trg_fleet_memory_touch BEFORE UPDATE ON app.fleet_memory
--     FOR EACH ROW EXECUTE FUNCTION app.fleet_memory_touch_updated_at();
--
--   and exactly one matching trigger function. The definition below is copied
--   verbatim from that dump, and is also exactly what PostgreSQL itself emits
--   for the trigger (pg_get_triggerdef), so it is the database's own answer to
--   "what was this" rather than a reconstruction.
--
--   Live counts now: 17 user triggers total (public 11, app 4, fleet_ops 2).
--   An earlier report in this session claimed 171 app triggers were lost; that
--   number was wrong — it came from a query that summed every user trigger in
--   the database and was misread as app-only. The real app-schema loss was
--   this single trigger.
--
-- IMPACT
--   No data was lost — triggers hold none. Without it, app.fleet_memory rows
--   stopped advancing updated_at on UPDATE, so recency ordering on the fleet
--   memory table silently became stale.
--
-- SAFE TO RE-RUN.
-- ============================================================================

CREATE OR REPLACE FUNCTION app.fleet_memory_touch_updated_at()
RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.fleet_memory_touch_updated_at() IS
  'Maintains app.fleet_memory.updated_at. Restored 2026-10-12 after being '
  'dropped with CASCADE during the visual-document RPC migration.';

DROP TRIGGER IF EXISTS trg_fleet_memory_touch ON app.fleet_memory;

CREATE TRIGGER trg_fleet_memory_touch
  BEFORE UPDATE ON app.fleet_memory
  FOR EACH ROW EXECUTE FUNCTION app.fleet_memory_touch_updated_at();

-- ── Verify ───────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relname = 'fleet_memory'
         AND t.tgname = 'trg_fleet_memory_touch' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_fleet_memory_touch was not created';
  END IF;
  RAISE NOTICE 'trg_fleet_memory_touch restored and verified';
END
$do$;