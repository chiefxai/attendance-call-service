CREATE TABLE IF NOT EXISTS care_manager_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  care_manager_id UUID REFERENCES athulya_care_managers(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  UNIQUE (user_id, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS care_manager_notifications_user_created_idx
  ON care_manager_notifications (organization_id, user_id, created_at DESC);

UPDATE organization_call_settings
SET settings=jsonb_set(settings,'{callRetry,maxConsecutiveNoAnswer}','3'::jsonb,TRUE),updated_at=NOW()
WHERE settings->'callRetry'->>'maxConsecutiveNoAnswer'='5';