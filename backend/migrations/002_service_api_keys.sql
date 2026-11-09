-- Scoped, revocable integration keys. Only a SHA-256 digest is persisted.
CREATE TABLE IF NOT EXISTS service_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS service_api_keys_org_active_idx
  ON service_api_keys(organization_id, created_at DESC) WHERE revoked_at IS NULL;
