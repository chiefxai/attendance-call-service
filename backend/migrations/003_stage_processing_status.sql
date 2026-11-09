ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_check_in_status_check;
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_check_in_status_check
  CHECK (check_in_status IN ('scheduled','calling','processing','follow_up','confirmed','missed','not_answered','review'));

ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_check_out_status_check;
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_check_out_status_check
  CHECK (check_out_status IN ('scheduled','calling','processing','follow_up','confirmed','missed','not_answered','review'));

