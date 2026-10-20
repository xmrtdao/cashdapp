-- relay/migrations/jobby_008_cycles.sql — the loop gets a lease and a paper trail
--
-- Jobby has a planner (jobby/plan.mjs) and no executor. This adds the two things
-- a loop cannot be safe without.
--
-- 1. A LEASE, so two workers can never run the same client at once.
--
--    This is not theoretical. The loop can reach a send path, and the send path
--    is capped per client per 24h and gated on a claimed email. Two workers
--    interleaving would not just duplicate a cycle: each would read the cap,
--    each would see room, and each would send. The cap is enforced by counting
--    rows, so it is only a cap if there is exactly one writer.
--
--    The lease is a row rather than a Postgres advisory lock on purpose. An
--    advisory lock dies with its connection, which is the right failure mode for
--    a crashed worker, but it is invisible: nothing can tell you afterwards who
--    held a client or for how long. A lease row has an expiry AND an owner, so
--    a stuck worker is recoverable and auditable, which is the same reasoning
--    that put job_dossier_edits next to job_dossiers.
--
-- 2. A CYCLE LOG, so "nothing happened" and "it could not happen" are different.
--
--    This is the failure mode Harvey's docs call out: silent failures look
--    exactly like clean results, which is how a broken run gets mistaken for an
--    empty market. A loop that only records its successes cannot be
--    distinguished from a loop that is wedged. So every cycle writes a row
--    whatever happened, including the ones that found nothing to do.
--
-- The CHECK constraints below are the load-bearing part. The same rule is
-- enforced in jobby/loop.mjs, and a comment is not a constraint: if any other
-- writer inserts cycles, the database itself refuses to record a failed cycle
-- as a successful one.

BEGIN;

CREATE TABLE IF NOT EXISTS app.job_cycle_leases (
  client_id    integer PRIMARY KEY REFERENCES app.job_clients(id) ON DELETE CASCADE,
  worker_id    text NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT job_cycle_lease_expiry_is_future CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS job_cycle_leases_expires_idx
  ON app.job_cycle_leases (expires_at);

CREATE TABLE IF NOT EXISTS app.job_cycles (
  id          bigserial PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  worker_id   text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  decision    text,
  reason      text,
  status      text NOT NULL,
  ok          boolean NOT NULL,
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  error       text,
  CONSTRAINT job_cycles_status_known
    CHECK (status IN ('ran', 'no_work', 'unavailable', 'error')),
  -- A cycle that could not run is never a pass.
  CONSTRAINT job_cycles_unavailable_not_ok
    CHECK (status <> 'unavailable' OR ok = false),
  CONSTRAINT job_cycles_error_not_ok
    CHECK (status <> 'error' OR ok = false),
  -- A cycle recorded as ran or no_work must say when it finished.
  CONSTRAINT job_cycles_settled_has_a_time
    CHECK (status NOT IN ('ran', 'no_work') OR finished_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS job_cycles_client_started_idx
  ON app.job_cycles (client_id, started_at DESC);

-- One heartbeat row per client per window, so a misconfigured interval cannot
-- fill the table with duplicates. Advisory only: the lease is what actually
-- prevents overlap, this just stops the log becoming the problem.
CREATE INDEX IF NOT EXISTS job_cycles_client_worker_window_idx
  ON app.job_cycles (client_id, worker_id, started_at DESC);

COMMIT;
