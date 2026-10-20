-- tasks_015_task_closure_reasons.sql
--
-- A TASK CAN LEAVE THE BOARD BY BEING DONE, OR BY NO LONGER BEING WORK.
--
-- Until now there was exactly one way out that was not "somebody typed it":
-- the operator cancelled it by hand and wrote a reason in metadata. Nothing in
-- the system could decide that a task had become unnecessary, and there was no
-- column to record it, so "this was solved by something else" and "this was
-- wrong" and "this was a duplicate" were all the same undifferentiated
-- CANCELLED.
--
-- The executor could not help. It selected any assigned task in
-- CLAIMED/IN_PROGRESS/REVIEW and worked it - including a task an operator had
-- held with a blocking_reason, because the executor never looked at that
-- column. A task parked for a decision and a task nobody wanted were both
-- simply executed.
--
-- So:
--   closed_reason  WHY a task left the board without being done
--   superseded_by  the task that took over its work, when there is one
--
-- and the rules are constraints, not comments: a task cannot be called
-- superseded without naming the survivor, and cannot be its own survivor.

ALTER TABLE app.tasks
  ADD COLUMN IF NOT EXISTS superseded_by text;

ALTER TABLE app.tasks
  ADD COLUMN IF NOT EXISTS closed_reason text;

-- The vocabulary of reasons a task can close without being done.
DO $$
BEGIN
  ALTER TABLE app.tasks
    ADD CONSTRAINT tasks_closed_reason_vocab
    CHECK (closed_reason IS NULL OR closed_reason IN (
      'superseded',        -- another task took this work over
      'already_done',      -- the work is finished, by someone or something else
      'duplicate',         -- the same work, tracked elsewhere
      'not_needed',        -- the request itself no longer applies
      'blocked',           -- waiting on a decision, and will not be worked
      'cancelled'          -- withdrawn by an operator
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "Superseded" without naming the survivor is a claim, not a record.
DO $$
BEGIN
  ALTER TABLE app.tasks
    ADD CONSTRAINT tasks_superseded_needs_survivor
    CHECK (closed_reason IS DISTINCT FROM 'superseded' OR superseded_by IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A task cannot supersede itself.
DO $$
BEGIN
  ALTER TABLE app.tasks
    ADD CONSTRAINT tasks_not_superseded_by_self
    CHECK (superseded_by IS NULL OR superseded_by <> id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A superseded task is finished. If it is still PENDING, the supersede was
-- recorded but nothing acted on it.
DO $$
BEGIN
  ALTER TABLE app.tasks
    ADD CONSTRAINT tasks_superseded_is_terminal
    CHECK (superseded_by IS NULL OR status IN ('CANCELLED','CLOSED','COMPLETED','DONE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS tasks_superseded_by_idx
  ON app.tasks (superseded_by)
  WHERE superseded_by IS NOT NULL;

COMMENT ON COLUMN app.tasks.closed_reason IS
  'Why this task left the board without being done: superseded | already_done '
  '| duplicate | not_needed | blocked | cancelled.';
COMMENT ON COLUMN app.tasks.superseded_by IS
  'The id of the task that took this work over. Required when closed_reason is '
  '''superseded''.';
