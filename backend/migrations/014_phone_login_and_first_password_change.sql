ALTER TABLE web_users
  ALTER COLUMN email DROP NOT NULL;

ALTER TABLE web_users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS athulya_care_managers_login_phone_idx
  ON athulya_care_managers (organization_id, phone)
  WHERE phone IS NOT NULL AND phone <> '';
