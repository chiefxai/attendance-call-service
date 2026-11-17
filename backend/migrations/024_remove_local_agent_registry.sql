-- ChiefVoice owns conversation templates and call execution. The attendance
-- service no longer stores local agents or campaigns.
DROP TABLE IF EXISTS call_campaigns;
DROP TABLE IF EXISTS call_agents;

-- Record the provider used by the session, not a local agent identifier.
ALTER TABLE attendance_sessions RENAME COLUMN agent_id TO call_provider;
ALTER TABLE attendance_sessions ALTER COLUMN call_provider SET DEFAULT 'chiefvoice';
UPDATE attendance_sessions AS attendance_session
SET call_provider = COALESCE((
  SELECT attempt.provider
  FROM attendance_call_attempts AS attempt
  WHERE attempt.session_id = attendance_session.id
  ORDER BY attempt.created_at DESC
  LIMIT 1
), 'chiefvoice');

ALTER TABLE call_records DROP COLUMN IF EXISTS agent_id;
ALTER TABLE call_records DROP COLUMN IF EXISTS campaign_id;
