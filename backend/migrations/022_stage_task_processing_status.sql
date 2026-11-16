-- Keep independent stage tasks compatible with the processing state used
-- while a completed ChiefVoice call's webhook result is being evaluated.
ALTER TABLE attendance_stage_tasks
  DROP CONSTRAINT IF EXISTS attendance_stage_tasks_status_check;

ALTER TABLE attendance_stage_tasks
  ADD CONSTRAINT attendance_stage_tasks_status_check
  CHECK (status IN (
    'scheduled',
    'calling',
    'processing',
    'follow_up',
    'confirmed',
    'missed',
    'not_answered',
    'review'
  ));
