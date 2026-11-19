-- Caregiver and care-manager attempts use independent numbering and retry budgets.
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_check_in_status_check;
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_check_in_status_check
  CHECK (check_in_status IN ('scheduled','calling','processing','retry','follow_up','escalated','unresolved','confirmed','missed','not_answered','review'));
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_check_out_status_check;
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_check_out_status_check
  CHECK (check_out_status IN ('scheduled','calling','processing','retry','follow_up','escalated','unresolved','confirmed','missed','not_answered','review'));

ALTER TABLE attendance_stage_tasks DROP CONSTRAINT IF EXISTS attendance_stage_tasks_status_check;
ALTER TABLE attendance_stage_tasks ADD CONSTRAINT attendance_stage_tasks_status_check
  CHECK (status IN ('scheduled','calling','processing','retry','follow_up','escalated','unresolved','confirmed','missed','not_answered','review'));

ALTER TABLE attendance_call_attempts DROP CONSTRAINT IF EXISTS attendance_call_attempts_call_target_role_check;
ALTER TABLE attendance_call_attempts ADD CONSTRAINT attendance_call_attempts_call_target_role_check
  CHECK (call_target_role IN ('employee','patient','care_manager'));
ALTER TABLE attendance_call_attempts DROP CONSTRAINT IF EXISTS attendance_call_attempts_session_id_stage_attempt_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_call_attempts_role_attempt_unique
  ON attendance_call_attempts(session_id,stage,call_target_role,attempt_number);
