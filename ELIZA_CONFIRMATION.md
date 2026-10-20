Work gate — RETIRED 2026-10-12. Not required, do not run.

The CLI (`scripts/xmrt_workgate.py`) and its `fleet_ops` schema remain on disk
as dormant infrastructure. Nothing in the running system references them. The
CLI's behaviour was checked by hand and worked; its test suite fails 8 of 10
because it hardcodes a Git-Bash path that does not exist on Windows.

The rules it was meant to enforce now stand as conventions in AGENTS.md:
an inspection is not an implementation, a modified file is not verified, and do
not manufacture a verification signal. Git history is the record.

See README_PROJECT_STATE.md before touching anything in fleet_ops.

This confirmation is retained for history. It originally asked to verify the
gate was working; that request no longer applies.

Signed: Vex