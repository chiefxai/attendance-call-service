ALTER TABLE inbound_calls
  ADD COLUMN IF NOT EXISTS booking_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS booking_schedule_session_id UUID REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booking_staff JSONB,
  ADD COLUMN IF NOT EXISTS booking_updated_at TIMESTAMPTZ;

ALTER TABLE inbound_calls DROP CONSTRAINT IF EXISTS inbound_calls_booking_status_check;
ALTER TABLE inbound_calls ADD CONSTRAINT inbound_calls_booking_status_check
  CHECK (booking_status IN ('not_started','calling','scheduled','not_answered','no_staff_available','needs_review'));

CREATE TABLE IF NOT EXISTS appointment_call_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  inbound_call_id UUID NOT NULL REFERENCES inbound_calls(id) ON DELETE CASCADE,
  candidate_index INTEGER NOT NULL CHECK (candidate_index >= 0),
  staff_context JSONB NOT NULL,
  agent_id UUID,
  provider TEXT NOT NULL DEFAULT 'vobiz',
  provider_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'placing' CHECK (status IN ('placing','ringing','in_progress','completed','no_answer','unavailable','confirmed','failed')),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  recording_object_key TEXT,
  recording_content_type TEXT,
  transcript TEXT,
  outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  stream_claimed_at TIMESTAMPTZ,
  stream_ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (inbound_call_id, candidate_index),
  UNIQUE (provider, provider_call_id)
);

CREATE INDEX IF NOT EXISTS appointment_call_attempts_enquiry_idx
  ON appointment_call_attempts (organization_id, inbound_call_id, candidate_index);
CREATE INDEX IF NOT EXISTS appointment_call_attempts_provider_idx
  ON appointment_call_attempts (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
