ALTER TABLE web_users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE web_users DROP CONSTRAINT IF EXISTS web_users_role_check;
ALTER TABLE web_users ADD CONSTRAINT web_users_role_check CHECK (role IN ('admin','care_manager'));
ALTER TABLE staff_directory ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT '';
ALTER TABLE patient_directory ADD COLUMN IF NOT EXISTS athulya_patient_uhid TEXT NOT NULL DEFAULT '';
ALTER TABLE patient_directory ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS athulya_care_managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  athulya_care_manager_id TEXT NOT NULL,
  app_user_id UUID REFERENCES web_users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, athulya_care_manager_id),
  UNIQUE (app_user_id)
);

CREATE TABLE IF NOT EXISTS athulya_integration_settings (
  organization_id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL DEFAULT 'Athulya Platform',
  api_base_url TEXT NOT NULL DEFAULT 'https://homecare.athulyaliving.net/api',
  encrypted_api_key TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES web_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS athulya_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  from_date DATE,
  to_date DATE,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  records_received INTEGER NOT NULL DEFAULT 0,
  records_upserted INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS athulya_sync_runs_org_started_idx ON athulya_sync_runs(organization_id, started_at DESC);

CREATE TABLE IF NOT EXISTS athulya_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  athulya_schedule_id TEXT,
  athulya_schedule_pk TEXT,
  patient_external_id TEXT,
  patient_uhid TEXT,
  patient_name TEXT,
  care_manager_external_id TEXT,
  care_manager_name TEXT,
  care_manager_phone TEXT,
  schedule_date DATE,
  start_time TEXT,
  end_time TEXT,
  schedule_status TEXT,
  service_name TEXT,
  service_from_date DATE,
  service_to_date DATE,
  active_service_status TEXT,
  care_plan TEXT,
  branch TEXT,
  vendor_company TEXT,
  raw_source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, athulya_schedule_id, athulya_schedule_pk)
);
CREATE INDEX IF NOT EXISTS athulya_schedules_org_date_idx ON athulya_schedules(organization_id, schedule_date);

CREATE TABLE IF NOT EXISTS athulya_schedule_caregivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  schedule_id UUID NOT NULL REFERENCES athulya_schedules(id) ON DELETE CASCADE,
  athulya_caregiver_id TEXT,
  caregiver_name TEXT,
  caregiver_phone TEXT,
  caregiver_schedule_status TEXT,
  UNIQUE (schedule_id, athulya_caregiver_id, caregiver_phone)
);

CREATE TABLE IF NOT EXISTS athulya_attendance_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  schedule_id UUID REFERENCES athulya_schedules(id) ON DELETE SET NULL,
  caregiver_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('check_in','check_out')),
  event_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_api_specification' CHECK (status IN ('pending','processing','synced','failed','retry_scheduled','awaiting_api_specification')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  external_reference TEXT,
  response_code INTEGER,
  response_body JSONB,
  error_message TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS athulya_attendance_submissions_org_status_idx ON athulya_attendance_submissions(organization_id, status, created_at DESC);
