-- PostgreSQL schema for durable attendance sessions and async job processing.
-- Apply with your normal migration runner; do not expose this database publicly.

CREATE TABLE IF NOT EXISTS call_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  language TEXT NOT NULL DEFAULT 'en',
  system_prompt TEXT NOT NULL DEFAULT '',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS call_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id UUID NOT NULL REFERENCES call_agents(id) ON DELETE RESTRICT,
  from_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_call_id TEXT,
  agent_id UUID,
  campaign_id UUID,
  from_number TEXT,
  to_number TEXT,
  status TEXT NOT NULL,
  provider_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_call_id)
);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  external_assignment_id TEXT NOT NULL,
  schedule_version TEXT NOT NULL DEFAULT '1',
  agent_id TEXT NOT NULL,
  language TEXT NOT NULL,
  employee JSONB NOT NULL,
  patient JSONB NOT NULL,
  assignment_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_number TEXT NOT NULL,
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  check_in_status TEXT NOT NULL DEFAULT 'scheduled',
  check_out_status TEXT NOT NULL DEFAULT 'scheduled',
  session_status TEXT NOT NULL DEFAULT 'active',
  active_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  backend_delivery_status TEXT NOT NULL DEFAULT 'pending',
  backend_delivery_response JSONB,
  backend_delivered_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, external_assignment_id, schedule_version),
  CHECK (check_in_status IN ('scheduled','calling','follow_up','confirmed','missed','not_answered','review')),
  CHECK (check_out_status IN ('scheduled','calling','follow_up','confirmed','missed','not_answered','review')),
  CHECK (session_status IN ('active','completed','exception','cancelled')),
  CHECK (backend_delivery_status IN ('pending','queued','delivered','failed'))
);

-- Keep upgrades safe for databases that already had the earlier status checks.
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_check_in_status_check;
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_check_in_status_check
  CHECK (check_in_status IN ('scheduled','calling','follow_up','confirmed','missed','not_answered','review'));
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_check_out_status_check;
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_check_out_status_check
  CHECK (check_out_status IN ('scheduled','calling','follow_up','confirmed','missed','not_answered','review'));

CREATE TABLE IF NOT EXISTS attendance_call_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('check_in','check_out')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  consecutive_no_answer_before INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_answer_before >= 0),
  call_target_role TEXT NOT NULL DEFAULT 'employee' CHECK (call_target_role IN ('employee','patient')),
  provider TEXT NOT NULL DEFAULT 'vobiz',
  provider_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_at TIMESTAMPTZ NOT NULL,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  recording_object_key TEXT,
  recording_content_type TEXT,
  recording_url TEXT,
  stream_started_at TIMESTAMPTZ,
  stream_ended_at TIMESTAMPTZ,
  transcript_id UUID,
  outcome JSONB,
  raw_provider_event JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, stage, attempt_number),
  UNIQUE (provider, provider_call_id)
);
ALTER TABLE attendance_call_attempts ADD COLUMN IF NOT EXISTS consecutive_no_answer_before INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_answer_before >= 0);

-- A PostgreSQL-backed global semaphore. All worker replicas share this table,
-- so provider concurrency stays capped across horizontally scaled workers.
CREATE TABLE IF NOT EXISTS outbound_call_slots (
  call_attempt_id UUID PRIMARY KEY REFERENCES attendance_call_attempts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS outbound_call_slots_expiry_idx ON outbound_call_slots(expires_at);
CREATE INDEX IF NOT EXISTS attendance_call_attempts_session_idx
  ON attendance_call_attempts(session_id, stage, attempt_number DESC);

CREATE TABLE IF NOT EXISTS attendance_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  call_attempt_id UUID NOT NULL UNIQUE REFERENCES attendance_call_attempts(id) ON DELETE RESTRICT,
  language TEXT,
  transcript TEXT NOT NULL,
  extraction JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS attendance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attendance_jobs_ready_idx
  ON attendance_jobs(status, run_at, created_at);
CREATE INDEX IF NOT EXISTS attendance_jobs_lease_idx
  ON attendance_jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS attendance_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attendance_audit_session_idx
  ON attendance_audit_events(session_id, created_at);
