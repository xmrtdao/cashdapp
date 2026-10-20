-- pfp_012_lead_timestamp_types.sql
--
-- TWO TIMESTAMP COLUMNS WERE TEXT, AND THE CODE READ ONE OF THEM AS A TIMESTAMP.
--
-- public.pfp_leads.first_reply_at and contract_sent_at were created as text.
-- The code then wrote NOW() into them - Postgres renders a timestamptz into a
-- text column as '2026-10-07 01:49:52.230842-06' - and later tried to read one
-- back as a timestamp:
--
--   UPDATE public.pfp_leads
--      SET first_reply_at = COALESCE(first_reply_at, NOW()), updated_at = NOW()
--    WHERE id = $1
--
-- COALESCE(text, timestamptz) has no common type, so Postgres raised
--   42804: COALESCE types text and timestamp with time zone cannot be matched
-- on EVERY reply from a known contact. The inbound row had already been
-- inserted by then, which is why 184 rows in public.pfp_inbound_emails carry
-- outcome IS NULL: the capture wrote the message, and then threw.
--
-- The stored values are timestamps that happen to have been kept as text. Every
-- one of them parses, so the columns are given the type they were always meant
-- to have. stage_entered_at had the same defect and was corrected the same way
-- (see ensureLeadStageSchema in relay/lib/pfp-lead-stages.mjs).

ALTER TABLE public.pfp_leads
  ALTER COLUMN first_reply_at TYPE timestamptz USING first_reply_at::timestamptz;

ALTER TABLE public.pfp_leads
  ALTER COLUMN contract_sent_at TYPE timestamptz USING contract_sent_at::timestamptz;
