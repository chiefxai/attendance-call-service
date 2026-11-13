CREATE TABLE IF NOT EXISTS mock_platform_server_settings (
  organization_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES web_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
