-- pfp_011_lead_contacts.sql
--
-- ONE EVENT, SEVERAL PEOPLE, ONE LEAD.
--
-- The inbox used to create a lead per sender address. That is the right rule for
-- a stranger and the wrong rule for a wedding: the groom replies, the planner
-- replies, the venue replies, and the pipeline grows three leads and no extra
-- understanding. Worse, the studio's own reply-from address became a lead, so
-- the CRM reported a "new organic inbound" that was the owner emailing himself.
--
-- The model this migration makes real:
--
--   pfp_leads          one row per EVENT / DEAL  (the thing that is quoted, paid
--                      for and delivered)
--   pfp_contacts       one row per PERSON        (email is the identity)
--   contacts.lead_id   attaches a person to the event
--   contacts.is_primary marks the one person the lead is named after
--
-- and a duplicate lead is never deleted: it is pointed at the survivor with
-- merged_into_lead_id, moved to `lost` with reason `duplicate`, and its history
-- stays readable. Evidence is not tidied away.
--
-- Identity across the thread is carried by thread_key: the subject with every
-- leading Re:/Fw: stripped, lowercased. A second person replying on the same
-- thread attaches to the existing lead instead of creating a new one.

-- ── contacts attach to a lead ───────────────────────────────────────────────
ALTER TABLE public.pfp_contacts
  ADD COLUMN IF NOT EXISTS lead_id uuid;

DO $$
BEGIN
  ALTER TABLE public.pfp_contacts
    ADD CONSTRAINT pfp_contacts_lead_fk
    FOREIGN KEY (lead_id) REFERENCES public.pfp_leads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.pfp_contacts
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

-- A primary contact must belong to a lead. "Primary" with no lead is a claim
-- with nothing to be primary of.
DO $$
BEGIN
  ALTER TABLE public.pfp_contacts
    ADD CONSTRAINT pfp_contacts_primary_needs_lead
    CHECK (NOT is_primary OR lead_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One person, one row. Case-insensitive, because Email@Example.com and
-- email@example.com are the same mailbox.
CREATE UNIQUE INDEX IF NOT EXISTS pfp_contacts_email_uniq
  ON public.pfp_contacts (lower(email))
  WHERE email IS NOT NULL;

-- Exactly one primary per lead.
CREATE UNIQUE INDEX IF NOT EXISTS pfp_contacts_one_primary_per_lead
  ON public.pfp_contacts (lead_id)
  WHERE is_primary AND lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pfp_contacts_lead_idx
  ON public.pfp_contacts (lead_id);

-- ── merge bookkeeping ──────────────────────────────────────────────────────
ALTER TABLE public.pfp_leads
  ADD COLUMN IF NOT EXISTS merged_into_lead_id uuid;

DO $$
BEGIN
  ALTER TABLE public.pfp_leads
    ADD CONSTRAINT pfp_leads_merged_into_fk
    FOREIGN KEY (merged_into_lead_id) REFERENCES public.pfp_leads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A lead cannot be merged into itself. Enforced, not documented.
DO $$
BEGIN
  ALTER TABLE public.pfp_leads
    ADD CONSTRAINT pfp_leads_no_self_merge
    CHECK (merged_into_lead_id IS NULL OR merged_into_lead_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS pfp_leads_merged_into_idx
  ON public.pfp_leads (merged_into_lead_id)
  WHERE merged_into_lead_id IS NOT NULL;

-- ── thread identity ────────────────────────────────────────────────────────
ALTER TABLE public.pfp_inbound_emails
  ADD COLUMN IF NOT EXISTS thread_key text;

-- Backfill: strip every leading Re:/Fw:/Fwd: and normalise whitespace.
UPDATE public.pfp_inbound_emails
   SET thread_key = lower(btrim(regexp_replace(
         coalesce(subject, ''),
         '^[[:space:]]*((re|fw|fwd)[[:space:]]*:[[:space:]]*)+',
         '', 'i')))
 WHERE thread_key IS NULL AND subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS pfp_inbound_thread_idx
  ON public.pfp_inbound_emails (thread_key, received_at)
  WHERE thread_key IS NOT NULL;

-- ── internal addresses never become leads ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pfp_internal_addresses (
  email      text PRIMARY KEY,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT pfp_internal_addresses_email_shape CHECK (email LIKE '%@%')
);

INSERT INTO public.pfp_internal_addresses (email, reason) VALUES
  ('pfpattendants@gmail.com',
   'Owner reply-from address ("Photographic & Communication Services", signed Joe). Not a client.'),
  ('bookings@partyfavorphoto.com',
   'Studio bookings mailbox. Not a client.')
ON CONFLICT (email) DO NOTHING;

-- The existing false lead created from the owner's own address is closed by
-- relay/scripts/pfp-consolidate-jaffee.mjs, which writes the stage-history row
-- as well. Kept out of the schema migration so a data correction cannot be
-- applied twice or without a record of why it happened.
