-- tasks_012_evidence_gate.sql
--
-- A task may not enter a stage that asserts execution finished without an
-- artifact that carries a non-empty artifact_url.
--
-- Why a trigger and not a CHECK: a CHECK constraint cannot read another table.
-- The function-level check in task-auto-advance exists so the automated path
-- can report `missing_artifact` and move the task to REVIEW instead of throwing;
-- this trigger is the part that no other writer can bypass.
--
-- The 11 rows currently in app.task_artifacts are all `screenshot` with an empty
-- URL. They are not evidence and do not satisfy this gate. That is deliberate:
-- an artifact row that carries no reference is a claim, not a check.
--
-- Entering INTEGRATE / COMPLETION / COMPLETED is the boundary. Moving to CLOSED
-- or CANCELLED is abandoning work, not completing it, so it is not gated.

CREATE OR REPLACE FUNCTION app.enforce_task_completion_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage
     AND NEW.stage IN ('INTEGRATE', 'COMPLETION', 'COMPLETED')
     AND NOT EXISTS (
       SELECT 1
         FROM app.task_artifacts a
        WHERE a.task_id = NEW.id
          AND a.artifact_url IS NOT NULL
          AND btrim(a.artifact_url) <> ''
     )
  THEN
    RAISE EXCEPTION
      'task % cannot enter stage % without an artifact carrying a non-empty artifact_url',
      NEW.id, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_task_completion_evidence ON app.tasks;
CREATE TRIGGER trg_enforce_task_completion_evidence
BEFORE UPDATE OF stage ON app.tasks
FOR EACH ROW
EXECUTE FUNCTION app.enforce_task_completion_evidence();

-- The trigger runs one EXISTS per stage transition; keep that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_task_artifacts_evidence
  ON app.task_artifacts (task_id)
  WHERE artifact_url IS NOT NULL AND btrim(artifact_url) <> '';

COMMENT ON TRIGGER trg_enforce_task_completion_evidence ON app.tasks IS
  'Blocks INTEGRATE/COMPLETION/COMPLETED without an artifact that has a non-empty artifact_url (tasks_012).';
