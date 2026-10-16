-- harbor_001_campaign.sql — 31Harbor tech-solutions campaign tables.
-- Mirrors the pfp_campaign_* pattern (sends log + suppression set).
-- No recipients are seeded here; the audience list is built separately
-- and the real-estate scrape pool is retired, not reused.
CREATE TABLE IF NOT EXISTS public.hb_campaign_sends (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  contact_name text,
  subject text NOT NULL,
  campaign text NOT NULL DEFAULT 'consult',
  status text NOT NULL DEFAULT 'sent',
  resend_id text,
  detail jsonb,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hb_campaign_sends_email_idx ON public.hb_campaign_sends (lower(email));
CREATE INDEX IF NOT EXISTS hb_campaign_sends_sent_idx ON public.hb_campaign_sends (sent_at);

CREATE TABLE IF NOT EXISTS public.hb_campaign_suppressions (
  email text PRIMARY KEY,
  reason text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
