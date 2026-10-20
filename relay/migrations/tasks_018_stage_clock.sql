-- tasks_018_stage_clock.sql
--
-- A TASK'S CLOCK NEVER STARTED.
--
-- app.tasks has two columns that only mean anything together:
--
--   stage_started_at            when the task entered its current stage
--   auto_advance_threshold_hours how long it may sit there
--
-- The auto-advance reads the first and writes the second. But stage_started_at
-- was written in exactly one place - a relay endpoint that changes a task's
-- stage by hand. Nothing set it when a task was CREATED, and nothing set it
-- when an agent was assigned one.
--
-- So a task filed through the fleet chat - the way most of them are filed -
-- had stage_started_at NULL from the moment it was born. The auto-advance's
-- progress pass skips those tasks entirely:
--
--   .not('stage_started_at', 'is', null)
--
-- which means their checklist was never counted, their progress stayed at
-- zero, and they never reached the 100% the auto-advance needs before it will
-- move them. Sixteen of the seventeen open tasks were invisible to both
-- passes. They were not stalled by a rule: they were invisible to one.
--
-- The clock is set by the database, not by each writer remembering to. A task
-- that has a stage has a clock; a task that moves stage gets a new clock.

CREATE OR REPLACE FUNCTION app.set_task_stage_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A task arrives in a stage, so its clock starts now.
    IF NEW.stage IS NOT NULL AND NEW.stage_started_at IS NULL THEN
      NEW.stage_started_at := now();
    END IF;
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
    -- The stage changed, so the time spent in the old stage is over and the
    -- new one starts now.
    NEW.stage_started_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_set_task_stage_clock ON app.tasks;
CREATE TRIGGER trg_set_task_stage_clock
BEFORE INSERT OR UPDATE OF stage ON app.tasks
FOR EACH ROW EXECUTE FUNCTION app.set_task_stage_clock();

-- The tasks that were filed without a clock. They get the time they last
-- moved, which is the closest honest answer to "when did this enter its
-- stage" - and it is far better than a clock that starts the moment this
-- migration runs, which would make a 500-hour-old task look brand new.
UPDATE app.tasks
   SET stage_started_at = COALESCE(updated_at, created_at, now())
 WHERE stage_started_at IS NULL
   AND stage IS NOT NULL;
