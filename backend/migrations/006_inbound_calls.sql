-- Inbound patient-support calls, separated from attendance assignment sessions.
CREATE TABLE IF NOT EXISTS inbound_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'vobiz',
  provider_call_id TEXT NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT,
  patient_id TEXT,
  patient_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_id UUID,
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'ringing',
  stream_claimed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  recording_object_key TEXT,
  recording_content_type TEXT,
  transcript TEXT,
  transcript_language TEXT,
  transcribed_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_call_id),
  CHECK (status IN ('ringing','in_progress','completed','no_answer','failed','canceled','cancelled'))
);
CREATE INDEX IF NOT EXISTS inbound_calls_org_recent_idx ON inbound_calls (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS inbound_calls_retention_idx ON inbound_calls (retention_expires_at);
CREATE INDEX IF NOT EXISTS patient_directory_phone_lookup_idx
  ON patient_directory (organization_id, (RIGHT(regexp_replace(COALESCE(phone_number,''), '[^0-9]', '', 'g'),10)))
  WHERE active=TRUE;
