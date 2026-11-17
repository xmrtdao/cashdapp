-- harnesses_002_health_modes.sql
--
-- The harness registry could not tell the difference between "this runtime is
-- broken" and "I have no idea how to ask". Every harness was probed the same
-- way - HTTP GET on <endpoint>/health - so:
--
--   * dsh was recorded as DOWN because the registry pointed at :18791, a port
--     nothing has ever listened on. The real harness is :3080, and its HTTP
--     root answers 401 because that IS the healthy state (the dsh auth wall).
--   * hermes was DOWN for the same reason: it is a stdio gateway with no HTTP
--     port at all, so it could never have been probed.
--   * ollama was recorded as HEALTHY while nothing was listening on :11434.
--   * openclaw, pi, qwen-code and claude-code were 'unknown / no endpoint',
--     which reads identically to a runtime that is merely broken.
--
-- So the registry carried a mix of true, false and unknowable verdicts, all
-- six days old, because runHealthChecks() was only ever reachable by hand.
--
-- This adds an explicit health MODE per harness, so the registry can answer
-- the question it was actually asked, and separates "not installed" from
-- "installed and broken".

ALTER TABLE app.harnesses
  ADD COLUMN IF NOT EXISTS health_mode   TEXT NOT NULL DEFAULT 'http',
  ADD COLUMN IF NOT EXISTS health_path   TEXT,
  ADD COLUMN IF NOT EXISTS health_process TEXT,
  ADD COLUMN IF NOT EXISTS ui_endpoint   TEXT,
  ADD COLUMN IF NOT EXISTS install_hint   TEXT,
  ADD COLUMN IF NOT EXISTS supervised     BOOLEAN NOT NULL DEFAULT false;

-- A CHECK on the mode, so a typo cannot silently become "probe it over HTTP
-- and see what happens" - which is how dsh ended up marked down.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'harnesses_health_mode_check') THEN
    ALTER TABLE app.harnesses
      ADD CONSTRAINT harnesses_health_mode_check
      CHECK (health_mode IN ('http', 'tcp', 'process', 'files', 'none'));
  END IF;
END $$;

COMMENT ON COLUMN app.harnesses.health_mode IS
  'http=GET endpoint+health_path (401/403 counts as alive: it is an auth wall); tcp=connect to the endpoint port; process=health_process matches a live command line; files=health_path exists on disk; none=not installed, nothing to probe';

COMMENT ON COLUMN app.harnesses.ui_endpoint IS
  'The URL that opens this harness''s own UI, if it has one. Usually the loopback auth proxy (relay/harness-proxy.mjs) rather than the raw port, so the iframe works.';

-- ── Ground truth, measured on 2026-11-15 ─────────────────────────────────
-- The endpoints below are the ones that actually answer on this machine.

UPDATE app.harnesses SET
  endpoint = 'http://127.0.0.1:4096',
  health_mode = 'http', health_path = '/health',
  ui_endpoint = 'http://127.0.0.1:4130',
  supervised = true,
  install_hint = NULL,
  capabilities = ARRAY['code','chat'],
  updated_at = NOW()
WHERE id = 'opencode';

-- dsh answers 401 on / - that is the auth wall, and it means the harness is
-- UP. Probe the port, not the HTTP status.
UPDATE app.harnesses SET
  endpoint = 'http://127.0.0.1:3080',
  health_mode = 'tcp', health_path = NULL,
  ui_endpoint = 'http://127.0.0.1:4131',
  supervised = true,
  install_hint = NULL,
  capabilities = ARRAY['code','research'],
  updated_at = NOW()
WHERE id = 'dsh';

UPDATE app.harnesses SET
  endpoint = 'http://127.0.0.1:4747',
  health_mode = 'tcp', health_path = NULL,
  ui_endpoint = 'http://127.0.0.1:4747',
  supervised = true,
  install_hint = 'Studio is running. Opening a project needs the one-time key that `openfilm open` prints.',
  capabilities = ARRAY['video','media','render'],
  updated_at = NOW()
WHERE id = 'openfilm';

UPDATE app.harnesses SET
  endpoint = 'http://127.0.0.1:11434',
  health_mode = 'http', health_path = '/api/tags',
  ui_endpoint = NULL,
  supervised = true,
  install_hint = NULL,
  capabilities = ARRAY['inference'],
  updated_at = NOW()
WHERE id = 'ollama';

-- Hermes is a stdio gateway. It has no port, so it is probed by looking for
-- its process. The MCP servers it spawns are the observable side effect.
UPDATE app.harnesses SET
  endpoint = NULL,
  health_mode = 'process', health_process = 'hermes_cli',
  health_path = NULL, ui_endpoint = NULL,
  supervised = true,
  install_hint = 'Runs as `pythonw -m hermes_cli.main gateway run` (uv cpython 3.11). It serves no HTTP port; the dashboard drives it through its MCP servers. Supervised by the local stack supervisor; it adopts the gateway by command-line match.',
  capabilities = ARRAY['chat','research','mining'],
  updated_at = NOW()
WHERE id = 'hermes';

-- MOSS-TTS-Nano is local ONNX inference. Its FastAPI server
-- (MOSS-TTS-Nano/app.py) listens on :18083; the relay tool `tts-generate`
-- still calls infer_onnx.py as a one-shot process, but the server is the
-- harness's own HTTP surface and is supervised.
UPDATE app.harnesses SET
  endpoint = 'http://127.0.0.1:18083',
  health_mode = 'http', health_path = '/',
  ui_endpoint = 'http://127.0.0.1:18083',
  supervised = true,
  install_hint = 'Local ONNX inference (CPU), FastAPI server on :18083 (MOSS-TTS-Nano/app.py). The relay tool `tts-generate` calls infer_onnx.py as a one-shot process; the server is the harness''s own HTTP surface.',
  capabilities = ARRAY['tts','voice-generation','audio'],
  updated_at = NOW()
WHERE id = 'moss-tts';

-- These four have no CLI on PATH and no port. They were recorded as
-- 'unknown / no endpoint', which is indistinguishable from a broken runtime.
-- Say the useful thing: they are not installed.
UPDATE app.harnesses SET
  endpoint = NULL,
  health_mode = 'none', health_path = NULL, health_process = NULL, ui_endpoint = NULL,
  supervised = false,
  install_hint = 'No CLI on PATH and no local runtime. Install it to make it available to task routing.',
  updated_at = NOW()
WHERE id IN ('openclaw', 'pi', 'qwen-code', 'claude-code');

-- The old 'unknown' verdict came from a probe that never ran. Clear it so the
-- first real health pass is not read as a transition.
UPDATE app.harnesses SET
  status = 'unknown',
  last_health_error = NULL,
  last_health_check = NULL,
  updated_at = NOW()
WHERE status = 'unknown' AND last_health_check IS NOT NULL;
