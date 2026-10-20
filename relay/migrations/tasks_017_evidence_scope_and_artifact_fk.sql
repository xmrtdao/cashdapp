-- tasks_017_evidence_scope_and_artifact_fk.sql
--
-- THE HELPER WAS ASKING ABOUT THE WRONG TASK.
--
-- app.task_has_real_evidence(task_id) was written as:
--
--   SELECT EXISTS (
--     SELECT 1 FROM app.task_artifacts a
--      WHERE a.task_id = task_id
--        AND a.artifact_url IS NOT NULL
--        AND btrim(a.artifact_url) <> ''
--        AND NOT app.artifact_is_self_referential(a.artifact_url, task_id)
--   )
--
-- In PostgreSQL, when a SQL function's parameter has the same name as a column
-- of a table in its FROM clause, the COLUMN wins for an unqualified reference.
-- So `a.task_id = task_id` was really `a.task_id = a.task_id` - true of every
-- row in the table - and the function answered "does ANY artifact anywhere
-- carry a real URL?" instead of "does THIS task?".
--
-- It did not show, and that is the dangerous part. Every artifact the fleet
-- had produced was either an empty screenshot or a pointer to its own task, so
-- the global answer and the per-task answer happened to be the same answer.
-- The first real deliverable - a pull request URL - would have opened the
-- gate for every task on the board at once.
--
-- The TRIGGERS that enforce the rule were written correctly: they compare
-- a.task_id = NEW.id, so the guard itself held. The published oracle did not,
-- and the oracle is what the executor, the board and the next reader trust.
--
-- The parameters are RENAMED, not merely qualified. A name that a column can
-- shadow is a trap, and the point of this function is to be believed.
--
-- PostgreSQL will not rename a parameter through CREATE OR REPLACE, so the
-- functions are dropped and recreated. Nothing depends on them: the triggers
-- call them from inside a plpgsql body, which is resolved at run time, and
-- this script puts the new definitions back before it ends.

DROP FUNCTION IF EXISTS app.artifact_is_self_referential(text, text);

CREATE FUNCTION app.artifact_is_self_referential(p_url text, p_task_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  -- The executor's URL ends in /api/suite/tasks/<id>, and other producers use
  -- /tasks/<id>. A LIKE on the full id after the segment is deliberate: a URL
  -- whose next character is part of a longer id is also excluded, because
  -- wrongly counting one artifact as evidence is the more expensive mistake.
  SELECT COALESCE(p_url, '') LIKE '%/tasks/' || p_task_id
$function$;

DROP FUNCTION IF EXISTS app.task_has_real_evidence(text);

CREATE FUNCTION app.task_has_real_evidence(p_task_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM app.task_artifacts a
     WHERE a.task_id = p_task_id
       AND a.artifact_url IS NOT NULL
       AND btrim(a.artifact_url) <> ''
       AND NOT app.artifact_is_self_referential(a.artifact_url, a.task_id)
  )
$function$;

-- AN ARTIFACT BELONGS TO A TASK.
--
-- app.task_artifacts had no foreign key to app.tasks, so an artifact could
-- outlive the task it described and sit in the table pointing at nothing. The
-- gate asks "does this task have evidence?", so an artifact with no task is
-- not evidence of anything - and while the function above was answering about
-- the whole table, one orphan URL was enough to satisfy it for every task.
--
-- Deleting the task deletes its evidence. That is the honest direction: an
-- artifact whose task is gone cannot be opened, read or checked by anyone.
DELETE FROM app.task_artifacts a
 WHERE NOT EXISTS (SELECT 1 FROM app.tasks t WHERE t.id = a.task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'app.task_artifacts'::regclass
       AND conname = 'task_artifacts_task_id_fkey'
  ) THEN
    ALTER TABLE app.task_artifacts
      ADD CONSTRAINT task_artifacts_task_id_fkey
      FOREIGN KEY (task_id) REFERENCES app.tasks(id) ON DELETE CASCADE;
  END IF;
END
$$;
