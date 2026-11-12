ALTER TABLE athulya_integration_settings
  ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_sync_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auto_sync_slot TEXT,
  ADD COLUMN IF NOT EXISTS auto_sync_scope TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS auto_sync_scope_id TEXT NOT NULL DEFAULT '';

ALTER TABLE athulya_integration_settings
  DROP CONSTRAINT IF EXISTS athulya_integration_settings_auto_sync_scope_check;
ALTER TABLE athulya_integration_settings
  ADD CONSTRAINT athulya_integration_settings_auto_sync_scope_check
  CHECK (auto_sync_scope IN ('all','branch','care_manager'));
