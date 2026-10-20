## Status: RETIRED (2026-10-12)

**The work gate is no longer required and must not be run.**

It was built, and the CLI itself was verified working by hand — mutual
exclusion, refused no-op completions, refused rebase from a failed receipt, and
stale-claim recovery were each exercised directly against the database. It was
retired because it cost more in friction than it returned, and because **no part
of the running system depended on it**: nothing in `relay/`, `suite/`, the
supervisor, the cron engine, or any MCP server references it.

What remains on disk, all dormant and safe to ignore:

| Artifact | State |
|---|---|
| `scripts/xmrt_workgate.py` | Working CLI. Nothing invokes it. |
| `db/migrations/20261012_001_create_fleet_ops_project_state.sql` | Applied to `xmrt_suite`. Forward-only and idempotent. |
| `fleet_ops` schema (4 tables) | Exists; holds only self-test rows. |
| `tests/test_xmrt_workgate.py` | **8 of 10 tests fail.** See below. |

### Do not run `20261009_001_create_fleet_ops_project_state.sql`

That migration begins with `DROP TABLE IF EXISTS` on all four tables. Re-running
it now would destroy every claim and receipt. The `20261012_001` migration
replaced it and is forward-only.

### The test suite does not pass

`tests/test_xmrt_workgate.py` hardcodes the Git-Bash path
`/c/Users/PureTrek/Desktop/xmrtdao`, which does not exist on Windows:

```
8 failed, 1 passed, 1 skipped
```

It also asserts against the old destructive migration and the previous CLI
contract. **This was not fixed**, because the feature is retired. Note it when
reading any earlier claim that the work gate was "confirmed working": the CLI's
behaviour was verified by hand and did work, but the test suite never passed on
this machine.

### What replaces it

The rules the gate existed to enforce now stand as conventions in `AGENTS.md`.
They are no longer mechanically enforced, which means the agent doing the work is
responsible for honouring them — notably: an inspection is not an
implementation, a modified file is not verified, and do not manufacture a
verification signal.

Git history is the record of what changed.

---

## Historical record (superseded — retained for context)

The following describes the system as originally built. It is kept because the
baseline hashes and design rationale still explain why the schema exists.

## What Was Created

### 1. Database State Layer (`/c/Users/PureTrek/Desktop/xmrtdao/db/migrations/20261009_001_create_fleet_ops_project_state.sql`)

**Purpose:** An idempotent migration that creates the authoritative state schema.

**Schema:** `fleet_ops` schema with four tables:
- `projects`: Project registry with root path
- `project_files`: Current state of tracked files (baseline/observed hashes, lifecycle)
- `work_claims`: Active work claims for files (agent, operation, base hash)
- `execution_receipts`: Immutable receipts of work (inputs, outputs, verification)

**Seed data:** One project row for `xmrtdao`.

### 2. Work Gate CLI (`/c/Users/PureTrek/Desktop/xmrtdao/scripts/xmrt_workgate.py`)

**Purpose:** CLI tool that enforces claim-and-receipt workflow.

**Commands:**
- `bootstrap`: Create project and register initial files
- `register <file>`: Add new file to project state
- `status [--json]`: View current state (canonical)
- `claim --agent <agent> --file <path> --operation <text>`: Acquire work
- `heartbeat --claim <uuid>`: Keep claim alive
- `verify --claim <uuid> --check <name> --passed <true|false> --detail <text>`: Record checks
- `complete --claim <uuid> --summary <text>`: Finalize with receipt
- `fail --claim <uuid> --reason <text>`: Mark as failed
- `release --claim <uuid>`: Free a claim
- `rebase --agent <agent> --file <path> --receipt <uuid>`: Update baseline

**Security features:**
- Path normalization and traversal protection
- Transaction advisory locks
- Only one active claim per file
- Stale base detection
- Immutable receipts
- Lifecycle state tracking

### 3. Test Suite (`/c/Users/PureTrek/Desktop/xmtdao/tests/test_xmrt_workgate.py`)

**Acceptance criteria (all must pass):**
1. The migration succeeds when run twice.
2. `status --json` returns canonical path, existence, mode, size, SHA-256, lifecycle state, active claim, and latest receipt.
3. Two agents cannot hold active claims for the same file.
4. A claim fails if the file changes after the claim is acquired.
5. Completion fails without a successful check.
6. Failed work creates a receipt and never advances the baseline.
7. A passed no-op must be explicit.
8. A path outside `/c/Users/PureTrek/Desktop/xmrtdao` is rejected.
9. A rebase requires a matching passed execution receipt.
10. Two independent CLI processes observe the same database-backed state.

### 4. Operating Contract (`/c/Users/PureTrek/Desktop/xmtdao/AGENTS.md`)

**WITHDRAWN 2026-10-12.** This originally read:

> Every agent making a repository change must run
> `/c/Users/PureTrek/Desktop/xmrtdao/scripts/xmrt_workgate.py status`

**That requirement no longer applies.** The rules it was written to enforce
survive in `AGENTS.md` as conventions rather than a mandatory CLI:

- Conversation history and generic logs are not authoritative state
- An inspection is not an implementation
- A modified file is not verified
- "Recovery proven" requires a restore that was actually performed
- Historical archive manifests must never be rewritten from live database state
- Do not manufacture a verification signal

## Current File Hashes (Baseline State)

Based on the confirmed backup files:

| Path | SHA-256 | Size | State |
|------|---------|------|-------|
| `backups/pg_backup.sh` | `50c937bad2c87535d96fc32c312a181e69edabe292e9f0914db95bdca3c6e639` | 6,021 | `implemented_unverified` |
| `backups/pg_verify_v2.sh` | `6148e01cfb52a77085055193f032c8549bb0d9a41db9ed69e16e40f708671374` | 16,392 | `pending_patch` |
| `backups/pg_verify.sh` | `29a161233e9d905fe2d4f81909ce6395f786db1c4b1a99354a4329846694fec1` | 3,338 | `baseline` |
| `backups/pg_backup.sh.v1` | `6309f12c844d50f08a0b3b4044bf9e86955194fa17861dd650a7661acbb0620c` | 1,078 | `baseline` |
| `backups/pg_verify_v2.sh.v1` | `6148e01cfb52a77085055193f032c8549bb0d9a41db9ed69e16e40f708671374` | 16,392 | `baseline` |
| `cron-runner.bat` | `8a8a06f07c098b3b8877f79ac222e82e64c8755ffd7dc9ce4651711e8ffc0cb6` | 861 | `baseline` |

## How It Solves the Problem

**Before:** The fleet had several activity feeds (`public.tool_calls`, `public.eliza_activity_log`, `system.activity_log`, `public.activity_feed`) that recorded work but did not authoritatively answer:
- What is the current file hash?
- Did an agent actually modify it?
- Which agent owns the edit?
- Were syntax or restore tests run?
- Is another agent working on it?
- Is the claimed change current, or was the file modified underneath them?

**Result:** Backup discussions repeatedly produced inspections and status reports rather than clean, verifiable patches.

**After:** This system provides:
- Authoritative state in PostgreSQL (`fleet_ops` schema)
- Claim-and-receipt workflow that distinguishes inspection from implementation
- Verification checks that must pass for a file to be considered verified
- Immutable receipts that prove work was done
- Transaction advisory locks that prevent concurrent work on the same file
- Explicit no-op flag to allow intentional unchanged work

**Future agents** will now be able to distinguish inspection from implementation and proof from optimism.

The backup repair also gets the durable claim-and-receipt mechanism it currently lacks.

## Installation and Usage  (SUPERSEDED — do not follow)

> ⚠️ Everything below described the work gate as an active, required workflow.
> **It is retired. Do not run these commands.** The text is kept only so the
> history of the design is not lost.

1. Ensure PostgreSQL `xmrt_suite` database is accessible at `localhost:5432`
2. Run the migration to create the schema
3. ~~For agent operations: always run `xmrt_workgate.py status` before work~~
   — **no longer required**
4. Read `AGENTS.md` for the current operating rules

## Tests  (SUPERSEDED)

> ⚠️ These tests fail (8 of 10) because they hardcode the Git-Bash path
> `/c/Users/...`, which does not exist on Windows. They were not repaired
> because the feature is retired. Do not read a red run here as a live problem.

```bash
python3 -m pytest tests/test_xmrt_workgate.py -v
```

---

*Historical note: this document previously ended by instructing agents to report
migration status and test results and to **not begin the backup-verifier repair
until this state layer passed its acceptance tests**. That gate is withdrawn.
The work gate is retired, and the backup-verifier work (`pg_verify_v2.sh`,
archive metadata checksums) is tracked as ordinary tasks rather than being
blocked on this.*