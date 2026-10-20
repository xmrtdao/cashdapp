#!/usr/bin/env python3
"""
xmrt_workgate.py — Authoritative project-state and execution gate CLI

This CLI enforces a claim-and-receipt mechanism for fleet agents making
repository changes. It provides:
- Bootstrap: Create project and register initial files
- Register: Add new files to the project state
- Status: View current state of files and claims
- Claim: Acquire exclusive work on a file
- Heartbeat: Keep a claim alive
- Verify: Record verification checks for a claim
- Complete: Finalize a claim with a receipt
- Fail: Mark a claim as failed
- Release: Free a claim
- Rebase: Update baseline from a passed receipt

STATE LOCATION
    All state lives in fleet_ops.project_files, fleet_ops.work_claims and
    fleet_ops.execution_receipts in the local PostgreSQL database `xmrt_suite`.
    That is the ONLY authoritative source for project state. Conversation
    history, chat logs and agent memory are not project state and are never
    consulted here.

INVARIANTS THIS TOOL ENFORCES
    1. One ACTIVE claim per (project_id, file_path). Enforced by a partial
       unique index in the database, so two agents racing for the same file
       cannot both win — the second gets a constraint violation, not a
       convention violation.
    2. A claim records base_sha256: the file hash at claim time. If the file
       changes underneath an agent, completion detects the drift.
    3. A modified file is NOT verified. Only `complete` with at least one
       PASSED verification check writes a `passed` receipt, and only a passed
       receipt may move baseline_sha256 (via `rebase`). An edit alone never
       advances the baseline.
    4. Claims go stale. `heartbeat` refreshes heartbeat_at; `claim --reap`
       releases claims whose heartbeat is older than the stale window so a
       crashed agent cannot hold a file forever.

SCHEMA NOTE
    The schema for this CLI is created by
    db/migrations/20261012_001_create_fleet_ops_project_state.sql
    That migration is forward-only and idempotent. Do NOT use
    db/migrations/20261009_001_create_fleet_ops_project_state.sql — it begins
    with DROP TABLE and would destroy every claim and receipt on re-run.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

# ── Configuration ──────────────────────────────────────────────
# PROJECT_ROOT is resolved from this file's location so the CLI works no
# matter which directory it is invoked from, and on any platform. The previous
# hardcoded "/c/Users/..." was a Git-Bash path that does not exist on Windows.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_URL = os.environ.get(
    "LOCAL_DATABASE_URL",
    os.environ.get("DATABASE_URL", "postgres://postgres@127.0.0.1:5432/xmrt_suite"),
)
PROJECT_ID = os.environ.get("XMRT_PROJECT_ID", "xmrtdao")

# A claim with no heartbeat for this long is considered abandoned.
STALE_CLAIM_MINUTES = int(os.environ.get("XMRT_STALE_CLAIM_MINUTES", "60"))

VALID_LIFECYCLE = ("registered", "claimed", "verified", "modified", "failed")
VALID_CLAIM_STATUS = ("active", "completed", "failed", "released")


# ── Helpers ────────────────────────────────────────────────────
def get_connection():
    """Get database connection from environment or default."""
    return psycopg2.connect(DB_URL)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def normalize_path(file_path: str) -> str:
    """Normalize a path to a POSIX-style path relative to the project root.

    Rejects anything that resolves outside the project — a work gate that can
    be pointed at /etc/passwd is not a work gate.
    """
    candidate = Path(file_path)
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    resolved = candidate.resolve()
    try:
        rel = resolved.relative_to(PROJECT_ROOT)
    except ValueError:
        raise ValueError(
            "Path %r resolves outside the project root (%s)" % (file_path, resolved)
        )
    return rel.as_posix()


def hash_file(abs_path: Path) -> str:
    """Calculate SHA-256 hash of a file's bytes."""
    h = hashlib.sha256()
    with open(abs_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def describe_file(rel_path: str):
    """Return (sha256, size_bytes, mode) for a registered file, or Nones."""
    abs_path = PROJECT_ROOT / rel_path
    if not abs_path.is_file():
        return None, None, None
    st = abs_path.stat()
    mode = "executable" if st.st_mode & 0o111 else "regular"
    return hash_file(abs_path), st.st_size, mode


def die(msg: str, code: int = 1):
    print("ERROR: %s" % msg, file=sys.stderr)
    sys.exit(code)


def ok(msg: str):
    print(msg)


# ── Commands ───────────────────────────────────────────────────
def cmd_bootstrap(args):
    """Create the project row if absent. Idempotent."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO fleet_ops.projects (project_id, root_path, description)
                VALUES (%s, %s, %s)
                ON CONFLICT (project_id) DO UPDATE SET root_path = EXCLUDED.root_path
                RETURNING project_id, created_at
                """,
                (PROJECT_ID, str(PROJECT_ROOT), "XMRT-DAO primary repository"),
            )
            row = cur.fetchone()
        conn.commit()
        ok("project %s bootstrapped (root: %s)" % (row[0], PROJECT_ROOT))
    finally:
        conn.close()
    return 0


def cmd_register(args):
    """Register a file in project state, recording its current hash."""
    rel = normalize_path(args.file)
    sha, size, mode = describe_file(rel)
    if sha is None:
        die("File not found: %s" % rel)

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO fleet_ops.project_files
                    (project_id, file_path, baseline_sha256, observed_sha256,
                     size_bytes, mode, lifecycle_state, registered_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'registered', %s)
                ON CONFLICT (project_id, file_path) DO UPDATE SET
                    observed_sha256 = EXCLUDED.observed_sha256,
                    size_bytes      = EXCLUDED.size_bytes,
                    mode            = EXCLUDED.mode,
                    registered_by   = EXCLUDED.registered_by,
                    updated_at      = now()
                RETURNING lifecycle_state
                """,
                (PROJECT_ID, rel, sha, sha, size, mode, args.agent or "unknown"),
            )
            state = cur.fetchone()[0]
        conn.commit()
    finally:
        conn.close()

    ok("registered %s  sha256=%s  lifecycle=%s" % (rel, sha[:12], state))
    return 0


def cmd_status(args):
    """Show registered files, active claims, and unverified drift."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT f.file_path, f.lifecycle_state,
                       f.baseline_sha256, f.observed_sha256
                  FROM fleet_ops.project_files f
                 WHERE f.project_id = %s
                 ORDER BY f.file_path
                """,
                (PROJECT_ID,),
            )
            files = cur.fetchall()

            cur.execute(
                """
                SELECT claim_id, file_path, owner_agent, operation,
                       heartbeat_at
                  FROM fleet_ops.work_claims
                 WHERE project_id = %s AND status = 'active'
                 ORDER BY acquired_at
                """,
                (PROJECT_ID,),
            )
            claims = cur.fetchall()

            cur.execute(
                """
                SELECT file_path, baseline_sha256, observed_sha256
                  FROM fleet_ops.project_files
                 WHERE project_id = %s
                 ORDER BY file_path
                """,
                (PROJECT_ID,),
            )
            rows = cur.fetchall()
        conn.close()
    finally:
        pass

    # Re-hash EVERY registered file against its recorded baseline.
    #
    # This used to select only rows where baseline_sha256 != observed_sha256,
    # which was decorative: `rebase` sets both columns to the same value, so a
    # file edited on disk afterwards updated neither column and was never even
    # considered. Verified: editing a registered file with no claim reported
    # "unverified drift (0)". The gate could be edited behind its own back and
    # status said everything was fine.
    #
    # The baseline is the only thing that matters — it is what a passed receipt
    # vouched for — so compare the disk against that, for every file.
    live_drift = []
    for rel, base, obs in rows:
        sha, _, _ = describe_file(rel)
        if sha is None:
            live_drift.append((rel, base, obs, "MISSING"))
        elif base is not None and sha != base:
            live_drift.append((rel, base, obs, sha))

    payload = {
        "project_id": PROJECT_ID,
        "root": str(PROJECT_ROOT),
        "files": [
            {"file_path": f[0], "lifecycle_state": f[1],
             "baseline_sha256": f[2], "observed_sha256": f[3]}
            for f in files
        ],
        "active_claims": [
            {"claim_id": str(c[0]), "file_path": c[1], "owner_agent": c[2],
             "operation": c[3], "heartbeat_at": c[4].isoformat()}
            for c in claims
        ],
        "unverified_drift": [
            {"file_path": d[0], "baseline": (d[1] or "")[:12],
             "observed": (d[2] or "")[:12], "on_disk_now": (d[3] or "")[:12]}
            for d in live_drift
        ],
    }

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    ok("project: %s" % PROJECT_ID)
    ok("root:    %s" % PROJECT_ROOT)
    ok("")
    ok("files (%d):" % len(files))
    ok("  (lifecycle 'verified' means a passed receipt moved the baseline;"
       " 'modified' means edited but NOT verified)")
    for f in files:
        ok("  %-60s %s" % (f[0][:60], f[1]))
    ok("")
    ok("active claims (%d):" % len(claims))
    if not claims:
        ok("  (none)")
    for c in claims:
        ok("  %s  %-40s %s / %s" % (str(c[0])[:8], c[1][:40], c[2], c[3]))
    ok("")
    ok("unverified drift (%d):" % len(live_drift))
    if not live_drift:
        ok("  (none — every registered file matches its baseline)")
    for d in live_drift:
        ok("  %-50s baseline=%s observed=%s disk=%s"
           % (d[0][:50], (d[1] or "-")[:12], (d[2] or "-")[:12], (d[3] or "-")[:12]))
    return 0


def cmd_claim(args):
    """Acquire exclusive work on a file.

    Fails if another agent holds an active claim — enforced by the database,
    not by this script.
    """
    rel = normalize_path(args.file)
    sha, size, mode = describe_file(rel)
    if sha is None:
        die("File not found: %s" % rel)

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            # Ensure the file is registered so status/receipts reference it.
            cur.execute(
                """
                INSERT INTO fleet_ops.project_files
                    (project_id, file_path, baseline_sha256, observed_sha256,
                     size_bytes, mode, lifecycle_state, registered_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'claimed', %s)
                ON CONFLICT (project_id, file_path) DO UPDATE SET
                    observed_sha256 = EXCLUDED.observed_sha256,
                    lifecycle_state = 'claimed',
                    updated_at = now()
                """,
                (PROJECT_ID, rel, sha, sha, size, mode, args.agent),
            )
            try:
                cur.execute(
                    """
                    INSERT INTO fleet_ops.work_claims
                        (project_id, file_path, owner_agent, operation,
                         base_sha256, status)
                    VALUES (%s, %s, %s, %s, %s, 'active')
                    RETURNING claim_id
                    """,
                    (PROJECT_ID, rel, args.agent, args.operation, sha),
                )
                claim_id = cur.fetchone()[0]
            except psycopg2.errors.UniqueViolation:
                conn.rollback()
                cur.execute(
                    """
                    SELECT owner_agent FROM fleet_ops.work_claims
                     WHERE project_id=%s AND file_path=%s AND status='active'
                    """,
                    (PROJECT_ID, rel),
                )
                holder = cur.fetchone()
                die(
                    "File already claimed by %s: %s"
                    % (holder[0] if holder else "another agent", rel),
                    code=2,
                )
        conn.commit()
    finally:
        conn.close()

    ok("claimed %s" % rel)
    ok("claim_id:  %s" % claim_id)
    ok("agent:     %s" % args.agent)
    ok("operation: %s" % args.operation)
    ok("base_sha256: %s" % sha)
    return 0


def cmd_heartbeat(args):
    """Refresh a claim's heartbeat so it is not reaped as stale."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE fleet_ops.work_claims
                   SET heartbeat_at = now()
                 WHERE claim_id = %s AND status = 'active'
                RETURNING claim_id, heartbeat_at
                """,
                (args.claim,),
            )
            row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    if not row:
        die("No active claim with id %s" % args.claim)
    ok("heartbeat %s at %s" % (row[0], row[1].isoformat()))
    return 0


def cmd_verify(args):
    """Record a verification check against a claim."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO fleet_ops.execution_receipts
                    (claim_id, project_id, agent_id, operation,
                     checks, status, summary, completed_at)
                SELECT c.claim_id, c.project_id, c.owner_agent, c.operation,
                       %s::jsonb, %s, %s, now()
                  FROM fleet_ops.work_claims c
                 WHERE c.claim_id = %s AND c.status = 'active'
                RETURNING receipt_id
                """,
                (
                    json.dumps([{
                        "name": args.check,
                        "passed": args.passed,
                        "detail": args.detail or "",
                        "recorded_at": now_iso(),
                    }]),
                    "passed" if args.passed else "failed",
                    "verification check: %s" % args.check,
                    args.claim,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    if not row:
        die("No active claim with id %s" % args.claim)
    ok("recorded check %s=%s for claim %s"
       % (args.check, "PASS" if args.passed else "FAIL", args.claim))
    return 0


def _has_passed_check(cur, claim_id):
    """True when at least one passed verification check exists for the claim."""
    cur.execute(
        """
        SELECT count(*) FROM fleet_ops.execution_receipts
         WHERE claim_id = %s AND status = 'passed'
           AND checks @> '[{"passed": true}]'
        """,
        (claim_id,),
    )
    return cur.fetchone()[0] > 0


def cmd_complete(args):
    """Finalize a claim, writing a receipt.

    The receipt records the file hash as it was at claim time (before) and as
    it is now (after). If the file changed, lifecycle_state becomes 'modified'
    — which is NOT verified. Verified is a separate `rebase` step that requires
    a passed receipt.
    """
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT project_id, file_path, owner_agent, operation, base_sha256
                  FROM fleet_ops.work_claims
                 WHERE claim_id = %s AND status = 'active'
                """,
                (args.claim,),
            )
            claim = cur.fetchone()
            if not claim:
                die("No active claim with id %s" % args.claim)

            _project, rel, agent, operation, base_sha = claim

            passed = _has_passed_check(cur, args.claim)
            after_sha, size, mode = describe_file(rel)
            changed = (after_sha is not None and after_sha != base_sha)

            # No-op completion: file untouched. Only honest with --no-op.
            if not changed and not args.no_op:
                die(
                    "File %s is unchanged from the claim hash (%s).\n"
                    "       If the work genuinely produced no change, re-run with --no-op."
                    % (rel, base_sha[:12]),
                    code=3,
                )

            status = "passed" if passed else "failed"

            cur.execute(
                """
                INSERT INTO fleet_ops.execution_receipts
                    (claim_id, project_id, agent_id, operation,
                     files_out, before_sha256, after_sha256, checks,
                     status, summary, completed_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb,
                        '[]'::jsonb, %s, %s, now())
                RETURNING receipt_id
                """,
                (
                    args.claim, _project, agent, operation,
                    json.dumps([rel]),
                    json.dumps({rel: base_sha}),
                    json.dumps({rel: after_sha or ""}),
                    status,
                    args.summary,
                ),
            )
            receipt_id = cur.fetchone()[0]

            cur.execute(
                """
                UPDATE fleet_ops.work_claims
                   SET status = 'completed', completed_at = now()
                 WHERE claim_id = %s
                """,
                (args.claim,),
            )

            # A modified file is 'modified', not 'verified'. Verification is a
            # distinct, deliberate step (rebase) gated on a passed receipt.
            new_state = "modified" if changed else "registered"
            cur.execute(
                """
                UPDATE fleet_ops.project_files
                   SET observed_sha256 = %s, size_bytes = %s, mode = %s,
                       lifecycle_state = %s, updated_at = now()
                 WHERE project_id = %s AND file_path = %s
                """,
                (after_sha, size, mode, new_state, _project, rel),
            )
        conn.commit()
    finally:
        conn.close()

    ok("completed claim %s" % args.claim)
    ok("receipt_id: %s" % receipt_id)
    ok("file:       %s" % rel)
    ok("changed:    %s" % ("yes" if changed else "no"))
    ok("checks:     %s" % ("at least one PASSED" if passed else "NONE PASSED"))
    ok("receipt:    %s" % status)
    if not passed:
        ok("")
        ok("NOTE: no passed verification check is attached to this claim.")
        ok("      The receipt is 'failed' and the baseline will NOT advance.")
    ok("")
    ok("This file is '%s', not verified. Run `rebase` with a PASSED receipt"
       % new_state)
    ok("to move the baseline — an edit alone never verifies a file.")
    return 0


def cmd_fail(args):
    """Mark a claim as failed and record why."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE fleet_ops.work_claims
                   SET status = 'failed', completed_at = now(),
                       error_summary = %s
                 WHERE claim_id = %s AND status = 'active'
                RETURNING file_path
                """,
                (args.reason, args.claim),
            )
            row = cur.fetchone()
            if not row:
                die("No active claim with id %s" % args.claim)
            cur.execute(
                """
                UPDATE fleet_ops.project_files pf
                   SET lifecycle_state = 'failed', updated_at = now()
                  FROM fleet_ops.work_claims c
                 WHERE c.claim_id = %s AND pf.project_id = c.project_id
                   AND pf.file_path = c.file_path
                """,
                (args.claim,),
            )
        conn.commit()
    finally:
        conn.close()

    ok("failed claim %s (%s)" % (args.claim, row[0]))
    ok("reason: %s" % args.reason)
    return 0


def cmd_release(args):
    """Release an active claim without recording a receipt."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE fleet_ops.work_claims
                   SET status = 'released', completed_at = now(),
                       error_summary = COALESCE(error_summary, 'released')
                 WHERE claim_id = %s AND status = 'active'
                RETURNING file_path
                """,
                (args.claim,),
            )
            row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    if not row:
        die("No active claim with id %s" % args.claim)
    ok("released claim %s (%s)" % (args.claim, row[0]))
    return 0


def cmd_reap(args):
    """Release active claims whose heartbeat is older than the stale window.

    A crashed agent would otherwise hold a file forever, since mutual
    exclusion is enforced by the database and nothing else can take it back.

    The window honours --minutes when supplied.
    """
    window = getattr(args, "minutes", None) or STALE_CLAIM_MINUTES
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE fleet_ops.work_claims
                   SET status = 'released', completed_at = now(),
                       error_summary = 'reaped: heartbeat older than the stale window'
                 WHERE project_id = %s
                   AND status = 'active'
                   AND heartbeat_at < now() - make_interval(mins => %s)
                RETURNING claim_id, file_path, owner_agent
                """,
                (PROJECT_ID, window),
            )
            rows = cur.fetchall()
        conn.commit()
    finally:
        conn.close()

    ok("reaped %d stale claim(s) (window: %d min)" % (len(rows), window))
    for r in rows:
        ok("  %s  %s  %s" % (str(r[0])[:8], r[1], r[2]))
    return 0


def cmd_rebase(args):
    """Move a file's baseline to the hash recorded in a PASSED receipt.

    This is the only way a file becomes 'verified'. Requires the receipt to
    belong to this project and to have status 'passed'.
    """
    rel = normalize_path(args.file)
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT r.receipt_id, r.status, r.agent_id, r.after_sha256
                  FROM fleet_ops.execution_receipts r
                 WHERE r.receipt_id = %s AND r.project_id = %s
                """,
                (args.receipt, PROJECT_ID),
            )
            receipt = cur.fetchone()
            if not receipt:
                die("Receipt %s not found for project %s" % (args.receipt, PROJECT_ID))
            if receipt[1] != "passed":
                die(
                    "Receipt %s has status '%s'. Only a PASSED receipt may move a "
                    "baseline — a modified file is not a verified file."
                    % (args.receipt, receipt[1]),
                    code=4,
                )

            recorded = (receipt[3] or {}).get(rel)
            if not recorded:
                die("Receipt %s does not record a hash for %s" % (args.receipt, rel))

            cur.execute(
                """
                UPDATE fleet_ops.project_files
                   SET baseline_sha256 = %s,
                       observed_sha256 = %s,
                       lifecycle_state = 'verified',
                       updated_at = now()
                 WHERE project_id = %s AND file_path = %s
                RETURNING baseline_sha256
                """,
                (recorded, recorded, PROJECT_ID, rel),
            )
            row = cur.fetchone()
            if not row:
                die("%s is not registered for project %s" % (rel, PROJECT_ID))
        conn.commit()
    finally:
        conn.close()

    ok("rebased %s" % rel)
    ok("baseline_sha256: %s" % row[0])
    ok("from receipt:     %s (passed, agent %s)" % (receipt[0], receipt[2]))
    ok("lifecycle_state:  verified")
    return 0


COMMANDS = {
    "bootstrap": cmd_bootstrap,
    "register": cmd_register,
    "status": cmd_status,
    "claim": cmd_claim,
    "heartbeat": cmd_heartbeat,
    "verify": cmd_verify,
    "complete": cmd_complete,
    "fail": cmd_fail,
    "release": cmd_release,
    "reap": cmd_reap,
    "rebase": cmd_rebase,
}


def main():
    parser = argparse.ArgumentParser(
        description="XMRT Work Gate - Authoritative project-state and execution gate CLI",
        epilog=(
        "State lives in fleet_ops.* — the only authoritative source for project "
        "state.\n\n"
        "Correct order for a change:\n"
        "  1. claim   (records base_sha256 BEFORE you edit)\n"
        "  2. edit the file\n"
        "  3. verify  (one or more checks, at least one --passed true)\n"
        "  4. complete (writes a passed receipt; file becomes 'modified')\n"
        "  5. rebase  (moves the baseline; file becomes 'verified')\n\n"
        "Claiming after editing makes base_sha256 equal the already-changed file,\n"
        "and `complete` will refuse it rather than certify a no-op as a change."
    ),
    )
    subparsers = parser.add_subparsers(dest="command")

    bp = subparsers.add_parser("bootstrap", help="Create the project row")
    bp.add_argument("--agent", "-a", help="Agent bootstrapping (recorded as default)")

    reg = subparsers.add_parser("register", help="Add a file to project state")
    reg.add_argument("file", help="File path to register")
    reg.add_argument("--agent", "-a", help="Agent registering the file")
    reg.add_argument("--operation", "-o", help="Operation being performed")

    stat = subparsers.add_parser("status", help="View current state of files and claims")
    stat.add_argument("--json", "-j", action="store_true", help="JSON output")

    cl = subparsers.add_parser("claim", help="Acquire exclusive work on a file")
    cl.add_argument("--agent", "-a", required=True, help="Agent claiming the file")
    cl.add_argument("--file", required=True, help="File path to claim")
    cl.add_argument("--operation", "-o", required=True, help="Operation being performed")

    hb = subparsers.add_parser("heartbeat", help="Keep a claim alive")
    hb.add_argument("--claim", required=True, help="Claim ID")

    vr = subparsers.add_parser("verify", help="Record a verification check for a claim")
    vr.add_argument("--claim", required=True, help="Claim ID")
    vr.add_argument("--check", required=True, help="Check name")
    vr.add_argument("--passed", required=True, type=lambda x: x.lower() == "true",
                    help="Passed (true/false)")
    vr.add_argument("--detail", "-d", help="Check detail")

    comp = subparsers.add_parser("complete", help="Finalize a claim with receipt")
    comp.add_argument("--claim", required=True, help="Claim ID")
    comp.add_argument("--summary", required=True, help="Completion summary")
    comp.add_argument("--no-op", action="store_true", help="Allow no-op completion")

    fl = subparsers.add_parser("fail", help="Mark a claim as failed")
    fl.add_argument("--claim", required=True, help="Claim ID")
    fl.add_argument("--reason", required=True, help="Reason for failure")

    rl = subparsers.add_parser("release", help="Free a claim")
    rl.add_argument("--claim", required=True, help="Claim ID")

    rp = subparsers.add_parser("reap", help="Release claims with stale heartbeats")
    rp.add_argument("--minutes", type=int, default=STALE_CLAIM_MINUTES,
                    help="Stale window in minutes (default %d)" % STALE_CLAIM_MINUTES)

    re = subparsers.add_parser("rebase", help="Update baseline from a passed receipt")
    re.add_argument("--agent", required=True, help="Agent performing rebase")
    re.add_argument("--file", required=True, help="File to rebase")
    re.add_argument("--receipt", required=True, help="Passed receipt ID")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    try:
        return COMMANDS[args.command](args)
    except psycopg2.OperationalError as e:
        die("Cannot reach the fleet_ops database: %s\n"
            "       Apply db/migrations/20261012_001_create_fleet_ops_project_state.sql first." % e)


if __name__ == "__main__":
    sys.exit(main())