-- Add brand_logo_url to job_clients to allow persistent logo storage per client.
-- This ensures the 'Design Agency' has a source of truth for the la la la logo.

ALTER TABLE app.job_clients 
ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;

COMMENT ON COLUMN app.job_clients.brand_logo_url IS 
'The canonical URL for the client brand logo, used by the PFP Visual Compositor.';
