CREATE TABLE IF NOT EXISTS organization_call_settings (
  organization_id TEXT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
