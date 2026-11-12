-- harnesses_001_registry.sql
-- Harness registry: tracks all agent harnesses (OpenClaw, Pi, Hermes, DSH, OpenCode, etc.)
-- managed by the local-sb/OpenHands control plane.

CREATE TABLE IF NOT EXISTS app.harnesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                    -- openclaw, pi, hermes, dsh, opencode, claude-code, qwen-code, ollama
  endpoint TEXT,                          -- HTTP endpoint (e.g., http://localhost:18789)
  status TEXT NOT NULL DEFAULT 'unknown', -- healthy, degraded, down, unknown
  last_health_check TIMESTAMPTZ,
  last_health_error TEXT,
  capabilities TEXT[] DEFAULT '{}',      -- e.g., {'code','research','mining','chat'}
  current_load INTEGER DEFAULT 0,
  max_load INTEGER DEFAULT 10,
  config JSONB DEFAULT '{}',
  pid INTEGER,
  started_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_harnesses_status ON app.harnesses (status);
CREATE INDEX IF NOT EXISTS idx_harnesses_type ON app.harnesses (type);

-- Seed with known harnesses
INSERT INTO app.harnesses (id, name, type, endpoint, status, capabilities, config) VALUES
  ('openclaw', 'OpenClaw', 'openclaw', 'http://localhost:18789', 'unknown', ARRAY['chat','code','research'], '{"port":18789}'::jsonb),
  ('hermes', 'Hermes', 'hermes', 'http://localhost:18790', 'unknown', ARRAY['chat','research','mining'], '{"port":18790}'::jsonb),
  ('dsh', 'DeepSeek Harness (DSH)', 'dsh', 'http://localhost:18791', 'unknown', ARRAY['code','research'], '{"port":18791}'::jsonb),
  ('opencode', 'OpenCode', 'opencode', 'http://localhost:4096', 'unknown', ARRAY['code','chat'], '{"port":4096}'::jsonb),
  ('ollama', 'Ollama', 'ollama', 'http://localhost:11434', 'unknown', ARRAY['inference'], '{"port":11434}'::jsonb),
  ('pi', 'Pi', 'pi', NULL, 'unknown', ARRAY['code'], '{}'::jsonb),
  ('qwen-code', 'Qwen Code', 'qwen-code', NULL, 'unknown', ARRAY['code'], '{}'::jsonb),
  ('claude-code', 'Claude Code', 'claude-code', NULL, 'unknown', ARRAY['code'], '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
