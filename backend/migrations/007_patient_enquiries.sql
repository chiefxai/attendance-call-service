CREATE TABLE IF NOT EXISTS care_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (duration_minutes BETWEEN 1 AND 10080)
);
CREATE UNIQUE INDEX IF NOT EXISTS care_activities_org_name_idx
  ON care_activities (organization_id, lower(name));
CREATE INDEX IF NOT EXISTS care_activities_org_active_idx
  ON care_activities (organization_id, active, lower(name));

ALTER TABLE inbound_calls
  ADD COLUMN IF NOT EXISTS enquiry_analysis_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS enquiry_analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS staff_suggestions JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS inbound_calls_enquiry_idx
  ON inbound_calls (organization_id, enquiry_analysis_status, started_at DESC);

UPDATE inbound_calls
SET enquiry_analysis_status='needs_details',
    enquiry_analysis='{"missingDetails":["activity","start_time","patient_district"]}'::jsonb
WHERE transcript IS NOT NULL AND enquiry_analysis_status='pending';
