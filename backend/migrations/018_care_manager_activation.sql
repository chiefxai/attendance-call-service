-- Care Manager accounts are explicitly enabled by an admin after provisioning.
ALTER TABLE athulya_care_managers ALTER COLUMN active SET DEFAULT FALSE;

UPDATE athulya_care_managers
SET active=FALSE,updated_at=NOW();

UPDATE web_users
SET active=FALSE,updated_at=NOW()
WHERE role='care_manager';

UPDATE web_sessions
SET revoked_at=NOW()
WHERE revoked_at IS NULL
  AND user_id IN (SELECT id FROM web_users WHERE role='care_manager');
