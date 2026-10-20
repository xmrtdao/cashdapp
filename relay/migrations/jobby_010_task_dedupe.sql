-- migrations/jobby_010_task_dedupe.sql
--
-- WHY THIS EXISTS
--
-- The fleet chat was flooded on 2026-10-17 with two compounding loops:
--
--   * "Investigate cron job errors" was CREATED 27 times in four hours.
--   * Every one of those creations was announced to fleet chat, and each
--     announcement contained the words "cron" and "error", which is exactly
--     the phrase fleet-chat-task-creator matched on. It was reading its own
--     output and creating the next copy.
--
-- The creating code had no dedupe. It is not enough to add dedupe to the
-- creating code, either, because there are three writers to app.tasks
-- (fleet-chat-task-creator, the task pipeline, and humans in the UI) and the
-- next writer will not remember. So the rule lives in the schema:
--
--   ONE OPEN TASK PER TITLE.
--
-- A duplicate that is already DONE stops counting as open, so the same
-- incident can legitimately recur later and be tracked again. That is the
-- difference between "no duplicates" and "no ability to record a recurrence",
-- and only one of those is what we want.
--
-- lower(title) because "Investigate cron job errors" and "investigate cron
-- job errors" are the same task, and title casing varies by writer.

-- Duplicate titles among OPEN tasks block the migration: silently dropping
-- them would delete work somebody filed, and the operator should look at them.
DO $$
DECLARE dupes text;
BEGIN
  SELECT string_agg(c || ' x' || n, ', ') INTO dupes FROM (
    SELECT lower(title) AS c, count(*) AS n
      FROM app.tasks
     WHERE status NOT IN ('DONE', 'CANCELLED', 'COMPLETED')
     GROUP BY lower(title)
    HAVING count(*) > 1
    ORDER BY n DESC
    LIMIT 20
  ) s;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot create the open-task-per-title index: these titles are already open more than once: %',
      dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_per_title
  ON app.tasks (lower(title))
  WHERE status NOT IN ('DONE', 'CANCELLED', 'COMPLETED');