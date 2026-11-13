-- links_001_schema.sql
-- Creates the links schema for branded short links, projects, and click tracking.
-- Used by xmrtdao-suite-mcp links_create, links_list, links_analytics tools.

CREATE SCHEMA IF NOT EXISTS links;

-- Projects (one per tenant/domain)
CREATE TABLE IF NOT EXISTS links.projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed projects
INSERT INTO links.projects (id, name, domain, description) VALUES
  ('party', 'Party Favor Photo', 'pfp.foto', 'Photo booth business short links'),
  ('harbor', '31 Harbor', '31harbor.com', '31 Harbor short links'),
  ('xmrt', 'XMRT Solutions', 'xmrtsolutions.com', 'XMRT ecosystem short links'),
  ('cuttlefish', 'CuttlefishLabs', 'cuttlefishlabs.io', 'CuttlefishLabs short links'),
  ('mobilemonero', 'MobileMonero', 'mobilemonero.com', 'MobileMonero short links')
ON CONFLICT (id) DO NOTHING;

-- Links (short links)
CREATE TABLE IF NOT EXISTS links.links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES links.projects(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  qr_code BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (domain, key)
);

-- Ensure unique constraint for ON CONFLICT (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'links.links'::regclass AND conname = 'links_domain_key_unique'
  ) THEN
    ALTER TABLE links.links ADD CONSTRAINT links_domain_key_unique UNIQUE (domain, key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_links_project ON links.links (project_id);
CREATE INDEX IF NOT EXISTS idx_links_domain_key ON links.links (domain, key);

-- Clicks (click tracking)
CREATE TABLE IF NOT EXISTS links.clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES links.links(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  country TEXT,
  device_type TEXT,
  referrer TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_clicks_link ON links.clicks (link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_date ON links.clicks (clicked_at);