-- tasks_016_evidence_not_self_referential.sql
--
-- A TASK POINTING AT ITSELF IS NOT EVIDENCE OF ANYTHING.
--
-- The executor recorded every completion with exactly this artifact:
--
--   artifact_type : work-log
--   artifact_url  : https://relay.mobilemonero.com/api/suite/tasks/<task id>
--
-- That URL is the task's own record. It says "this task exists"; it says
-- nothing about whether any work was done, and it cannot: it is the page the
-- work would be described on. The database guard asked for "an artifact
-- carrying a non-empty artifact_url" and got one - and the guard, which can
-- check the shape of evidence but not its substance, was satisfied by a
-- pointer to the thing that was supposed to be proven.
--
-- So the guard now also asks the only question it can answer about a URL:
-- does it point back at this task? If it does, it does not count.
--
-- The ten tasks the executor completed on 2026-10-19 between 23:10 and 23:50
-- carry only self-referential evidence, so under this rule they do not count as
-- completed work. They are flagged for review rather than left standing as
-- facts.

-- Is this artifact URL a pointer back at the task it is attached to?
CREATE OR REPLACE FUNCTION app.artifact_is_self_referential(url text, task_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  -- The executor's URL ends in /api/suite/tasks/<id>, and other producers use
  -- /tasks/<id>. A LIKE on the full id after the segment is deliberate: a URL
  -- whose next character is part of a longer id is also excluded, because
  -- wrongly counting one artifact as evidence is the more expensive mistake.
  SELECT COALESCE(url, '') LIKE '%/tasks/' || task_id
$function$;

CREATE OR REPLACE FUNCTION app.enforce_task_completion_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage
     AND NEW.stage IN ('INTEGRATE', 'COMPLETION', 'COMPLETED')
     AND NOT EXISTS (
       SELECT 1
         FROM app.task_artifacts a
        WHERE a.task_id = NEW.id
          AND a.artifact_url IS NOT NULL
          AND btrim(a.artifact_url) <> ''
          AND NOT app.artifact_is_self_referential(a.artifact_url, NEW.id)
     )
  THEN
    RAISE EXCEPTION
      'task % cannot enter stage % without an artifact carrying a non-empty artifact_url',
      NEW.id, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

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
          AND NOT app.artifact_is_self_referential(a.artifact_url, NEW.id)
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

DROP TRIGGER IF EXISTS trg_enforce_task_completion_evidence ON app.tasks;
CREATE TRIGGER trg_enforce_task_completion_evidence
BEFORE UPDATE OF stage ON app.tasks
FOR EACH ROW EXECUTE FUNCTION app.enforce_task_completion_evidence();

DROP TRIGGER IF EXISTS trg_enforce_task_completion_status ON app.tasks;
CREATE TRIGGER trg_enforce_task_completion_status
BEFORE UPDATE OF status ON app.tasks
FOR EACH ROW EXECUTE FUNCTION app.enforce_task_completion_status_evidence();

-- A task that claims completion on the strength of a URL that points at its
-- own record is not completed, and the board should not show it as such.
--
-- The name says what it answers. An earlier draft of this function was called
-- task_evidence_is_self_referential and returned TRUE when the task DID have
-- real evidence - the opposite of what the name promised, which is the kind
-- of thing that gets trusted later by someone who never reads the body.
CREATE OR REPLACE FUNCTION app.task_has_real_evidence(task_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM app.task_artifacts a
     WHERE a.task_id = task_id
       AND a.artifact_url IS NOT NULL
       AND btrim(a.artifact_url) <> ''
       AND NOT app.artifact_is_self_referential(a.artifact_url, task_id)
  )
$function$;

DROP FUNCTION IF EXISTS app.task_evidence_is_self_referential(text);
