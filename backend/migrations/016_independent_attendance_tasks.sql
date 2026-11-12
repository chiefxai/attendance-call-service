-- A duty assignment remains a shared directory/display record. Check-in and
-- check-out each receive an independent durable task and callback lifecycle.
CREATE TABLE IF NOT EXISTS attendance_stage_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  assignment_session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('check_in','check_out')),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','calling','follow_up','confirmed','missed','not_answered','review')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  active_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','queued','delivered','failed')),
  delivery_response JSONB,
  delivered_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assignment_session_id,stage)
);

CREATE INDEX IF NOT EXISTS attendance_stage_tasks_org_stage_status_idx
  ON attendance_stage_tasks (organization_id,stage,status,scheduled_at);

INSERT INTO attendance_stage_tasks
  (organization_id,assignment_session_id,stage,status,scheduled_at,active_context,retention_expires_at)
SELECT organization_id,id,'check_in',check_in_status,scheduled_start_at,
  COALESCE(active_context->'checkIn','{}'::jsonb),retention_expires_at
FROM attendance_sessions
ON CONFLICT (assignment_session_id,stage) DO NOTHING;

INSERT INTO attendance_stage_tasks
  (organization_id,assignment_session_id,stage,status,scheduled_at,active_context,retention_expires_at)
SELECT organization_id,id,'check_out',check_out_status,scheduled_end_at,
  COALESCE(active_context->'checkOut','{}'::jsonb),retention_expires_at
FROM attendance_sessions
ON CONFLICT (assignment_session_id,stage) DO NOTHING;
