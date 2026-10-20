-- relay/migrations/jobby_009_checkin.sql — Jobby asks, then waits
--
-- The loop needs a fourth thing after the lease and the cycle log: a way to talk
-- to the person it works for, and a rule that after it asks, it stops until
-- they answer.
--
-- Email is the first channel, on the candidate's own @jobbymcjobberson.com
-- address, so the conversation is with an agent that has a name rather than with
-- a no-reply robot. More channels come later; the state machine does not care
-- which transport carried it, because everything below is about the client's
-- relationship to an open question, not about SMTP.
--
-- THE ANTI-SPAM RULE IS A CONSTRAINT, NOT A PROMPT.
--
-- "Don't email the user too often" written in a system prompt is a suggestion.
-- A loop runs unattended: it will re-decide, a cycle will fail, a retry will
-- fire, and somewhere in that is a second email. So the rule that matters is
-- enforced here, in the only place that cannot be argued with:
--
--     at most ONE open check-in per client, ever.
--
-- While a question is unanswered, a second cannot be created by any writer,
-- including a future one nobody has written yet. The loop's cadence, the retry
-- path and the escalation path all hit this index, so the failure mode is a
-- loud error naming a real reason rather than an inbox the candidate has muted.
--
-- What this does NOT do is rate-limit the cadence. That is deliberately code,
-- because a rate is a policy the operator should be able to change without a
-- migration, and because "at most one open" is the safety property while "not
-- more than N a day" is a preference.

BEGIN;

CREATE TABLE IF NOT EXISTS app.job_checkins (
  id            bigserial PRIMARY KEY,
  client_id     integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  decision      text,
  reason        text,
  from_address  text NOT NULL,
  to_address    text NOT NULL,
  subject       text,
  body          text,
  urgent        boolean NOT NULL DEFAULT false,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  answered_at   timestamptz,
  answered_text text,
  still_open    boolean NOT NULL DEFAULT true,
  CONSTRAINT job_checkins_kind_known
    CHECK (kind IN ('progress', 'question', 'urgent', 'closing')),
  -- An open check-in is an unanswered one. A row that is neither sent nor
  -- answered is not a check-in, it is an intention, and intentions do not
  -- suppress the next real question.
  CONSTRAINT job_checkins_open_needs_a_body
    CHECK (NOT still_open OR body IS NOT NULL)
);

-- The anti-spam constraint. One unanswered question at a time, per client.
CREATE UNIQUE INDEX IF NOT EXISTS job_checkins_one_open_idx
  ON app.job_checkins (client_id) WHERE still_open;

CREATE INDEX IF NOT EXISTS job_checkins_client_sent_idx
  ON app.job_checkins (client_id, sent_at DESC);

-- Urgent things, so the wait has a documented way out.
--
-- The loop waits by default. That is correct most of the time and wrong at
-- exactly the moments that matter most: an offer, an interview slot, a
-- deadline. These are recorded separately from check-ins because they are not
-- questions - they are events, and the response to an event is action, not a
-- letter. Keeping them in one table with a nullable column would make it
-- possible to close an offer by replying to it politely.
CREATE TABLE IF NOT EXISTS app.job_escalations (
  id           bigserial PRIMARY KEY,
  client_id    integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  acted_on_at  timestamptz,
  action       text,
  -- An event nobody acted on is a failure, not a log line. Exactly once: the
  -- loop marks it acted when it responds, and a second responder must not
  -- double-respond to the same offer.
  CONSTRAINT job_escalations_acted_is_not_null_when_stamped
    CHECK (acted_on_at IS NULL OR action IS NOT NULL)
);

-- One unacted escalation per kind, per client.
--
-- On (client_id, kind) and NOT (client_id, kind, detected_at). The timestamp was
-- in the first version of this index, which made it unique per instant and so
-- deduplicated nothing - the same offer arriving on two consecutive poll ticks
-- produced two rows, and two notifications about one offer. The verification
-- caught it by raising the same offer twice and being raised twice.
--
-- On (client_id, kind) the semantics are the ones actually wanted: at most one
-- unacted event of each kind. Once acted on, it falls out of the partial index,
-- so a genuinely new offer later raises a fresh one.
DROP INDEX IF EXISTS app.job_escalations_one_unacted_idx;
CREATE UNIQUE INDEX IF NOT EXISTS job_escalations_one_unacted_idx
  ON app.job_escalations (client_id, kind)
  WHERE acted_on_at IS NULL;

CREATE INDEX IF NOT EXISTS job_escalations_client_idx
  ON app.job_escalations (client_id, detected_at DESC);

COMMIT;
