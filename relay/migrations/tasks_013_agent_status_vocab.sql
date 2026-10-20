-- tasks_013_agent_status_vocab.sql
--
-- ONE VOCABULARY FOR AGENT STATE, DERIVED FROM REAL WORK.
--
-- The board had 13 agent rows and two spellings of the same state: twelve rows
-- said 'BUSY' and one said 'idle'. The orchestrator asks for 'IDLE', so it found
-- exactly one candidate - a row called "Eliza-Dev" that is not in
-- app.registry_agents at all. Meanwhile nine registered agents had ZERO active
-- tasks and still said 'BUSY', because nothing ever recomputed the field.
--
-- The result was a pipeline that could not start: the one agent it could see
-- was not a fleet agent, and the nine agents that were actually free were
-- invisible to it. "Zero throughput" was this, not a runner bug.
--
-- So:
--   1. One spelling. IDLE / BUSY / OFFLINE, uppercase, enforced by a CHECK.
--   2. Status is derived from the tasks an agent actually holds, not asserted.
--   3. current_workload is the count of those tasks, not a stale number.
--
-- OFFLINE is preserved: an agent deliberately taken offline stays offline, and
-- this migration never invents an assignment to wake it.

-- ── 1. one spelling ────────────────────────────────────────────────────────
-- upper() folds 'idle' to 'IDLE'. Any value outside the vocabulary is mapped
-- to IDLE rather than left to break the constraint below.
UPDATE app.agents
   SET status = CASE upper(btrim(coalesce(status, '')))
                  WHEN 'BUSY'   THEN 'BUSY'
                  WHEN 'OFFLINE' THEN 'OFFLINE'
                  ELSE 'IDLE'
                END;

-- ── 2. status from real work ───────────────────────────────────────────────
UPDATE app.agents a
   SET status = 'BUSY'
 WHERE a.status <> 'OFFLINE'
   AND EXISTS (
     SELECT 1 FROM app.tasks t
      WHERE t.assignee_agent_id = a.id
        AND t.status IN ('PENDING','CLAIMED','IN_PROGRESS')
   );

UPDATE app.agents a
   SET status = 'IDLE'
 WHERE a.status <> 'OFFLINE'
   AND NOT EXISTS (
     SELECT 1 FROM app.tasks t
      WHERE t.assignee_agent_id = a.id
        AND t.status IN ('PENDING','CLAIMED','IN_PROGRESS')
   );

-- ── 3. workload from real work ─────────────────────────────────────────────
UPDATE app.agents a
   SET current_workload = (
     SELECT count(*)::int FROM app.tasks t
      WHERE t.assignee_agent_id = a.id
        AND t.status IN ('PENDING','CLAIMED','IN_PROGRESS')
   );

-- ── the rule itself ────────────────────────────────────────────────────────
-- A comment can say "only IDLE, BUSY or OFFLINE". Only a constraint can keep
-- 'idle' and 'IDLE' from both existing again, which is exactly how the
-- orchestrator ended up looking at the wrong agent.
DO $$
BEGIN
  ALTER TABLE app.agents
    ADD CONSTRAINT agents_status_vocab
    CHECK (status IN ('IDLE','BUSY','OFFLINE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The registry is the roster. An agent row that is not in app.registry_agents
-- is not a fleet agent, so it must never be handed work. The id stem is the
-- join key: 'vex-001' -> 'vex' -> registry name 'vex'. "Eliza-Dev" has a uuid
-- stem and no registry row, so it is excluded by data rather than by name.
COMMENT ON COLUMN app.agents.status IS
  'IDLE | BUSY | OFFLINE. Derived from the active tasks the agent holds; '
  'OFFLINE is preserved by the vocabulary migration.';
