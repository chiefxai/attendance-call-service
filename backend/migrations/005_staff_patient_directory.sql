CREATE TABLE IF NOT EXISTS staff_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  address TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, external_id)
);
CREATE INDEX IF NOT EXISTS staff_directory_org_name_idx
  ON staff_directory (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS patient_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone_number TEXT,
  address TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  care_category TEXT NOT NULL DEFAULT '',
  hub TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, external_id)
);
CREATE INDEX IF NOT EXISTS patient_directory_org_name_idx
  ON patient_directory (organization_id, lower(name));
