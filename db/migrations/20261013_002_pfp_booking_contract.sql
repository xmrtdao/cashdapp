-- ============================================================================
-- PFP booking funnel: contract + signature columns on app.pfp_bookings
-- ============================================================================
-- app.pfp_bookings carried the commercial shape of a booking but none of the
-- paper. The self-serve funnel has to render a contract, capture a signature and
-- prove afterwards that the two belong together, so those facts need columns
-- of their own rather than being packed into `notes`.

ALTER TABLE app.pfp_bookings
  ADD COLUMN IF NOT EXISTS event_name        text,
  ADD COLUMN IF NOT EXISTS rate_id           text,
  ADD COLUMN IF NOT EXISTS start_time        text,
  ADD COLUMN IF NOT EXISTS end_time          text,
  ADD COLUMN IF NOT EXISTS address           text,
  -- Public token for the confirmation page. NOT the booking id: the id is a
  -- uuid that appears in the studio link too, and a token is rotatable, so a
  -- leaked URL can be invalidated without touching the booking.
  ADD COLUMN IF NOT EXISTS booking_token     text,
  -- sha256 of the unsigned contract body. Every signature record binds to this
  -- value; a mismatch means the document was altered after it was agreed.
  ADD COLUMN IF NOT EXISTS contract_sha256   text,
  -- The signature records as JSON: role, name, signed_at, ip, user agent,
  -- signature image hash, verbatim consent text and its version.
  ADD COLUMN IF NOT EXISTS sign_records      jsonb,
  ADD COLUMN IF NOT EXISTS provider_signature jsonb,
  ADD COLUMN IF NOT EXISTS hold_expires_at   timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at           timestamptz,
  ADD COLUMN IF NOT EXISTS notified_fleet    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refunded_at       timestamptz;

-- The confirmation link is looked up by token on every page load, so it needs
-- an index. Partial: most bookings will never have one.
CREATE UNIQUE INDEX IF NOT EXISTS pfp_bookings_token_uniq
  ON app.pfp_bookings(booking_token) WHERE booking_token IS NOT NULL;

-- The funnel advances a booking through stages; every lookup is "what is still
-- sitting in this stage".
CREATE INDEX IF NOT EXISTS pfp_bookings_stage_created_idx
  ON app.pfp_bookings(funnel_stage, created_at DESC);

COMMENT ON COLUMN app.pfp_bookings.sign_records IS
  'Client signature records, each bound to contract_sha256. Appending the '
  'provider signature does not change this array: both roles bind to the same '
  'contract body hash.';
COMMENT ON COLUMN app.pfp_bookings.booking_token IS
  'Public token for /confirmation/<token>. Rotatable; not the primary key.';

-- ── Fleet notification outbox ───────────────────────────────────────────────
-- The brief is that paying posts to fleet chat. Polling a chat API from inside
-- a Stripe webhook means a Stripe retry can produce duplicate messages and a
-- chat outage can fail a payment, so the two are decoupled: the webhook records
-- the fact, and this table is the queue a worker drains.
--
-- Uniqueness is on (booking_id, channel) so a redelivered webhook cannot create
-- a second message for the same booking.
CREATE TABLE IF NOT EXISTS app.pfp_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES app.pfp_bookings(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  payload     jsonb NOT NULL,
  state       text NOT NULL DEFAULT 'pending',
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  CONSTRAINT pfp_outbox_once UNIQUE (booking_id, channel)
);

CREATE INDEX IF NOT EXISTS pfp_outbox_pending_idx
  ON app.pfp_outbox(state, created_at) WHERE state = 'pending';
