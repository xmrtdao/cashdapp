-- ============================================================================
-- PFP booking: kit inventory + nightly availability
-- ============================================================================
-- WHY THIS EXISTS
--   Countersigning was a manual brake on overbooking: nobody was paid until
--   Joe signed. Replacing that with inventory means the database must be the
--   brake instead, and it has to hold under two people clicking "Pay" at once.
--   That is what the unique index below is for. An availability check alone is
--   a race; a unique constraint is a guarantee.
--
-- FOUR KITS, SEVEN NIGHTS. A kit is a physical booth: the DSLR, the strobe
-- rig, the attendant's kit. Each can be booked on a given night, up to
-- `capacity` simultaneous bookings.

CREATE TABLE IF NOT EXISTS app.pfp_kits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  capacity     integer NOT NULL DEFAULT 1,
  active       boolean NOT NULL DEFAULT true,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.pfp_kits IS
  'Physical inventory. Four photo booth kits; each is bookable on a given night.';

-- A kit/date pair may be booked up to `capacity` times. This UNIQUE index is
-- what makes concurrency safe: two simultaneous reservations for the same
-- kit and date cannot both commit.
CREATE TABLE IF NOT EXISTS app.pfp_availability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id       uuid NOT NULL REFERENCES app.pfp_kits(id) ON DELETE CASCADE,
  booking_date date NOT NULL,
  booked_count integer NOT NULL DEFAULT 0,
  held_count   integer NOT NULL DEFAULT 0,
  -- when a hold expires without payment the slot is released automatically
  hold_expires_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pfp_avail_unique_kit_date UNIQUE (kit_id, booking_date),
  CONSTRAINT pfp_avail_nonneg CHECK (booked_count >= 0 AND held_count >= 0)
);

CREATE INDEX IF NOT EXISTS pfp_avail_date_idx ON app.pfp_availability(booking_date);

-- Extends pfp_bookings with the fields the funnel needs. Added rather than
-- creating a parallel table so the existing fleet-chat booking flow keeps
-- working unchanged.
ALTER TABLE app.pfp_bookings
  ADD COLUMN IF NOT EXISTS kit_id            uuid REFERENCES app.pfp_kits(id),
  ADD COLUMN IF NOT EXISTS contract_url      text,
  ADD COLUMN IF NOT EXISTS client_signature  text,
  ADD COLUMN IF NOT EXISTS countersigned_at  timestamptz,
  ADD COLUMN IF NOT EXISTS signed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_url       text,
  ADD COLUMN IF NOT EXISTS stripe_session    text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent text,
  ADD COLUMN IF NOT EXISTS amount_total      numeric,
  ADD COLUMN IF NOT EXISTS amount_deposit    numeric,
  ADD COLUMN IF NOT EXISTS funnel_stage      text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS studio_url        text,
  ADD COLUMN IF NOT EXISTS source            text;

COMMENT ON COLUMN app.pfp_bookings.funnel_stage IS
  'new | contracted | paying | paid | designing | approved. '
  'Counts as booked once it reaches paid.';
COMMENT ON COLUMN app.pfp_bookings.source IS
  'web | webhook | operator. Distinguishes a self-serve booking from a '
  'manual one entered by the team.';

CREATE INDEX IF NOT EXISTS pfp_bookings_funnel_idx ON app.pfp_bookings(funnel_stage);

-- Atomic reservation. Returns the rows claimed, so the caller knows exactly
-- which kit the client got rather than guessing.
--
-- The UPDATE takes a row lock; the post-update re-read then guarantees that
-- even with concurrent callers, total claims can never exceed capacity.
-- Releasing stale holds first is what stops an abandoned checkout from burning
-- a date.
--
-- NAME SHADOWING: the OUT parameters below are named kit_id / kit_name / avail,
-- which are also column names on pfp_availability. Inside plpgsql an unqualified
-- `kit_id` resolves to the *variable*, so `ON CONFLICT (kit_id, booking_date)`
-- raises "column reference kit_id is ambiguous" and every reservation fails.
-- Every column reference below is therefore table-qualified, and the conflict
-- target is named by constraint rather than by column.
CREATE OR REPLACE FUNCTION app.reserve_pfp_kit(
  p_date      date,
  p_capacity  integer DEFAULT 1,
  p_hold_mins integer DEFAULT 30
) RETURNS TABLE(kit_id uuid, kit_name text, avail integer)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_kit uuid;
  v_nm  text;
  v_av  integer;
BEGIN
  -- Release expired holds on this date so abandoned carts free their slot.
  UPDATE app.pfp_availability AS a
     SET held_count      = GREATEST(0, a.held_count - 1),
         hold_expires_at = NULL
   WHERE a.booking_date = p_date
     AND a.hold_expires_at IS NOT NULL
     AND a.hold_expires_at < now();

  FOR v_kit, v_nm, v_av IN
    SELECT k.id, k.name,
           (k.capacity - COALESCE(a.booked_count,0) - COALESCE(a.held_count,0))
      FROM app.pfp_kits k
      LEFT JOIN app.pfp_availability a
             ON a.kit_id = k.id AND a.booking_date = p_date
     WHERE k.active
     ORDER BY COALESCE(a.booked_count,0) + COALESCE(a.held_count,0) ASC
  LOOP
    IF v_av >= p_capacity THEN
      INSERT INTO app.pfp_availability(kit_id, booking_date, held_count,
                                       hold_expires_at)
      VALUES (v_kit, p_date, 1, now() + make_interval(mins => p_hold_mins))
      ON CONFLICT ON CONSTRAINT pfp_avail_unique_kit_date DO UPDATE
        SET held_count     = app.pfp_availability.held_count + 1,
            hold_expires_at = now() + make_interval(mins => p_hold_mins),
            updated_at      = now()
      RETURNING app.pfp_availability.kit_id INTO v_kit;

      -- Re-read the post-update state under the row lock we just took.
      SELECT (k.capacity - a.booked_count - a.held_count)
        INTO v_av
        FROM app.pfp_kits k
        JOIN app.pfp_availability a
          ON a.kit_id = k.id AND a.booking_date = p_date
       WHERE k.id = v_kit;

      IF v_av >= 0 THEN
        kit_id := v_kit; kit_name := v_nm; avail := v_av;
        RETURN NEXT;
        RETURN;
      END IF;

      -- Over capacity after all: undo the hold we just took and try the
      -- next kit. Falling through here (rather than returning) is what lets a
      -- loser move on instead of walking away with a phantom hold.
      UPDATE app.pfp_availability AS a
         SET held_count      = GREATEST(0, a.held_count - 1),
             hold_expires_at = NULL
       WHERE a.kit_id = v_kit AND a.booking_date = p_date;
    END IF;
  END LOOP;

  -- Loop exhausted: the date is full. Return no rows rather than raising, so
  -- the caller can show "that date is fully booked" instead of a 500.
  RETURN;
END
$fn$;

COMMENT ON FUNCTION app.reserve_pfp_kit(date, integer, integer) IS
  'Atomically reserve one kit for a date. Returns zero rows when the date is '
  'fully booked. This replaces the manual countersign step as the overbooking '
  'brake: the database refuses the booking, not a person.';

-- Release or convert a hold.
CREATE OR REPLACE FUNCTION app.commit_pfp_kit(
  p_kit   uuid,
  p_date  date,
  p_final boolean DEFAULT true          -- true = paid, false = abandoned
) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_final THEN
    UPDATE app.pfp_availability
       SET booked_count = booked_count + 1,
           held_count   = GREATEST(0, held_count - 1),
           hold_expires_at = NULL,
           updated_at = now()
     WHERE kit_id = p_kit AND booking_date = p_date;
  ELSE
    UPDATE app.pfp_availability
       SET held_count   = GREATEST(0, held_count - 1),
           hold_expires_at = NULL,
           updated_at = now()
     WHERE kit_id = p_kit AND booking_date = p_date;
  END IF;
END
$fn$;

-- How many kits are free on a date (for the calendar UI).
CREATE OR REPLACE FUNCTION app.pfp_availability_on(p_date date)
RETURNS TABLE(kit_name text, capacity integer, booked integer, available integer)
LANGUAGE sql STABLE AS $sql$
  SELECT k.name, k.capacity,
         COALESCE(a.booked_count, 0),
         k.capacity - COALESCE(a.booked_count, 0) - COALESCE(a.held_count, 0)
    FROM app.pfp_kits k
    LEFT JOIN app.pfp_availability a
           ON a.kit_id = k.id AND a.booking_date = p_date
   WHERE k.active
   ORDER BY k.name
$sql$;

-- Seed the four kits.
--
-- Idempotency is done by name lookup, NOT by ON CONFLICT: pfp_kits has no
-- unique index on `name`, so `ON CONFLICT DO NOTHING` would never fire and a
-- re-run would quietly insert four duplicate kits — halving the real capacity
-- the booking check believes it has. A UNIQUE(name) is added below so this
-- cannot drift, whatever code touches the table next.
CREATE UNIQUE INDEX IF NOT EXISTS pfp_kits_name_uniq ON app.pfp_kits(name);

DO $seed$
DECLARE n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['Kit 1','Kit 2','Kit 3','Kit 4'] LOOP
    IF NOT EXISTS (SELECT 1 FROM app.pfp_kits WHERE name = n) THEN
      INSERT INTO app.pfp_kits (name, capacity) VALUES (n, 1);
    END IF;
  END LOOP;
END
$seed$;