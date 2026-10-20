-- ============================================================================
-- fleet_ops project-state schema
-- Created: 2026-10-12
--
-- WHY THIS FILE EXISTS INSTEAD OF RUNNING db/migrations/20261009_001_...
--   The existing migration starts with `DROP TABLE IF EXISTS` on all four
--   tables. That is fine while the schema does not exist, but it is a
--   landmine: re-running it after the fleet starts recording claims and
--   receipts would silently destroy every claim and every execution receipt —
--   i.e. exactly the authoritative history AGENTS.md says must never be
--   rewritten. This file is forward-only and idempotent instead, so it is
--   safe to re-run and safe to run against a populated fleet_ops.
--
--   Original destructive migration is left untouched on disk; nothing rewrites
--   an existing artifact.
--
-- SAFE TO RE-RUN: every statement is IF NOT EXISTS / OR REPLACE.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS fleet_ops;

COMMENT ON SCHEMA fleet_ops IS
  'Authoritative project state for fleet agents: registered files, exclusive '
  'work claims, and execution receipts. This is the ONLY source of truth for '
  'project state — conversation history and logs are not.';

-- ── 1. projects ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_ops.projects (
    project_id   TEXT PRIMARY KEY,
    root_path    TEXT NOT NULL UNIQUE,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE fleet_ops.projects IS
  'One row per registered project. root_path is unique so a project cannot be '
  'registered twice under different ids.';

-- ── 2. project_files ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_ops.project_files (
    project_id       TEXT NOT NULL,
    file_path        TEXT NOT NULL,
    baseline_sha256  CHAR(64),          -- last verified-good hash (archive truth)
    observed_sha256  CHAR(64),          -- hash as last seen on disk
    size_bytes       BIGINT,
    mode             TEXT,
    lifecycle_state  TEXT NOT NULL,     -- registered|claimed|verified|modified|failed
    registered_by    TEXT NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, file_path),
    CONSTRAINT project_files_fk_project
      FOREIGN KEY (project_id) REFERENCES fleet_ops.projects(project_id)
      ON DELETE CASCADE
);

COMMENT ON COLUMN fleet_ops.project_files.baseline_sha256 IS
  'Last hash that passed a verification check. Only a passed execution receipt '
  'may move this. An edit alone must never move it.';

COMMENT ON COLUMN fleet_ops.project_files.observed_sha256 IS
  'Hash as last observed on disk. Differs from baseline means modified and '
  'NOT verified — that gap is the whole point of the table.';

-- ── 3. work_claims ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_ops.work_claims (
    claim_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    owner_agent    TEXT NOT NULL,
    operation      TEXT NOT NULL,
    base_sha256    CHAR(64) NOT NULL,   -- hash at claim time; detects drift mid-claim
    status         TEXT NOT NULL,       -- active|completed|failed|released
    heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    error_summary  TEXT,
    CONSTRAINT work_claims_fk_project
      FOREIGN KEY (project_id) REFERENCES fleet_ops.projects(project_id)
      ON DELETE CASCADE
);

COMMENT ON COLUMN fleet_ops.work_claims.base_sha256 IS
  'File hash when the claim was taken. Compared against the current hash on '
  'complete to detect that the file changed underneath the agent.';

-- ── 4. execution_receipts ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_ops.execution_receipts (
    receipt_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id       UUID NOT NULL REFERENCES fleet_ops.work_claims(claim_id),
    project_id     TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    operation      TEXT NOT NULL,
    files_in       JSONB NOT NULL DEFAULT '[]'::jsonb,
    files_out      JSONB NOT NULL DEFAULT '[]'::jsonb,
    before_sha256  JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_sha256   JSONB NOT NULL DEFAULT '{}'::jsonb,
    checks         JSONB NOT NULL DEFAULT '[]'::jsonb,
    status         TEXT NOT NULL,       -- passed|failed
    summary        TEXT NOT NULL,
    error_summary  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    CONSTRAINT execution_receipts_fk_project
      FOREIGN KEY (project_id) REFERENCES fleet_ops.projects(project_id)
      ON DELETE CASCADE
);

COMMENT ON TABLE fleet_ops.execution_receipts IS
  'Proof that work was actually executed and verified. A modified file is NOT '
  'verified — only a receipt with status=''passed'' makes it so. "Recovery '
  'proven" requires a passed restore receipt and no other artifact counts.';

-- ── 5. indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_project_files_project_id
  ON fleet_ops.project_files(project_id);

CREATE INDEX IF NOT EXISTS idx_work_claims_project_file
  ON fleet_ops.work_claims(project_id, file_path);

CREATE INDEX IF NOT EXISTS idx_work_claims_status
  ON fleet_ops.work_claims(status);

CREATE INDEX IF NOT EXISTS idx_work_claims_stale
  ON fleet_ops.work_claims(heartbeat_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_execution_receipts_project_created
  ON fleet_ops.execution_receipts(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_receipts_claim
  ON fleet_ops.execution_receipts(claim_id);

-- Only one ACTIVE claim per (project, file). This is the mutual-exclusion
-- primitive: a second agent claiming the same file is blocked at the database,
-- not by convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_claim_per_project_file
  ON fleet_ops.work_claims(project_id, file_path)
  WHERE status = 'active';

-- ── 6. updated_at maintenance ───────────────────────────────────
CREATE OR REPLACE FUNCTION fleet_ops.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_touch ON fleet_ops.projects;
CREATE TRIGGER trg_projects_touch
  BEFORE UPDATE ON fleet_ops.projects
  FOR EACH ROW EXECUTE FUNCTION fleet_ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_project_files_touch ON fleet_ops.project_files;
CREATE TRIGGER trg_project_files_touch
  BEFORE UPDATE ON fleet_ops.project_files
  FOR EACH ROW EXECUTE FUNCTION fleet_ops.touch_updated_at();