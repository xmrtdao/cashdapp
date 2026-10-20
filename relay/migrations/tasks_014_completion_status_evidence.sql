-- tasks_014_completion_status_evidence.sql
--
-- THE STAGE TRIGGER HAD A DOOR LEFT OPEN.
--
-- trg_enforce_task_completion_evidence fires BEFORE UPDATE OF stage. It stops
-- a task from ENTERING INTEGRATE, COMPLETION or COMPLETED without an artifact
-- carrying a non-empty URL.
--
-- But stage is not the only way to finish a task. status is, and the stage
-- trigger never looked at it:
--
--   UPDATE app.tasks SET status = 'COMPLETED' WHERE id = ...;
--
-- sets the task to complete, leaves the stage alone, and no trigger fires. The
-- task reads as finished on every board and list with no artifact behind it.
-- The task orchestrator's bulk_update_task_status action could do exactly that.
--
-- So the same rule is applied to the column that actually decides whether
-- anyone sees a task as done: a task cannot TAKE a completed status without an
-- artifact either. Same evidence, same trigger, both doors.

CREATE OR REPLACE FUNCTION app.enforce_task_completion_status_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('COMPLETED','DONE')
     AND NOT EXISTS (
       SELECT 1
         FROM app.task_artifacts a
        WHERE a.task_id = NEW.id
          AND a.artifact_url IS NOT NULL
          AND btrim(a.artifact_url) <> ''
     )
  THEN
    RAISE EXCEPTION
      'task % cannot take status % without an artifact carrying a non-empty artifact_url',
      NEW.id, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_task_completion_status ON app.tasks;

CREATE TRIGGER trg_enforce_task_completion_status
BEFORE UPDATE OF status ON app.tasks
FOR EACH ROW EXECUTE FUNCTION app.enforce_task_completion_status_evidence();
