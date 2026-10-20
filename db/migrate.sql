-- Idempotent migration: create fleet_ops project state schema
-- Created: 2026-10-09

-- Drop existing fleet_ops tables if they exist (safe for re-runs)
DROP TABLE IF EXISTS fleet_ops.projects;
DROP TABLE IF EXISTS fleet_ops.project_files;
DROP TABLE IF EXISTS fleet_ops.work_claims;
DROP TABLE IF EXISTS fleet_ops.execution_receipts;

-- 1. Create fleet_ops.projects table
CREATE TABLE fleet_ops.projects (
    project_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create fleet_ops.project_files table
CREATE TABLE fleet_ops.project_files (
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    baseline_sha256 CHAR(64),
    observed_sha256 CHAR(64),
    size_bytes BIGINT,
    mode TEXT,
    lifecycle_state TEXT NOT NULL,
    registered_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, file_path)
);

-- 3. Create fleet_ops.work_claims table
CREATE TABLE fleet_ops.work_claims (
    claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    owner_agent TEXT NOT NULL,
    operation TEXT NOT NULL,
    base_sha256 CHAR(64) NOT NULL,
    status TEXT NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    error_summary TEXT
);

-- 4. Create fleet_ops.execution_receipts table
CREATE TABLE fleet_ops.execution_receipts (
    receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES fleet_ops.work_claims(claim_id),
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    files_in JSONB NOT NULL DEFAULT '[]'::jsonb,
    files_out JSONB NOT NULL DEFAULT '[]'::jsonb,
    before_sha256 JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_sha256 JSONB NOT NULL DEFAULT '{}'::jsonb,
    checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    error_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

-- Indexes for performance
CREATE INDEX idx_project_files_project_id ON fleet_ops.project_files(project_id);
CREATE INDEX idx_work_claims_project_file ON fleet_ops.work_claims(project_id, file_path);
CREATE INDEX idx_work_claims_status ON fleet_ops.work_claims(status);
CREATE INDEX idx_execution_receipts_project_created ON fleet_ops.execution_receipts(project_id, created_at DESC);

-- Partial unique index: only one active claim per project/file
CREATE UNIQUE INDEX idx_active_claim_per_project_file 
    ON fleet_ops.work_claims(project_id, file_path) 
    WHERE status = 'active';
