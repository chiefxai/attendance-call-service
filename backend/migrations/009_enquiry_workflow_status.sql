ALTER TABLE inbound_calls
  ADD COLUMN IF NOT EXISTS enquiry_status TEXT NOT NULL DEFAULT 'processing',
  ADD COLUMN IF NOT EXISTS resolved_staff JSONB,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

UPDATE inbound_calls
SET enquiry_status = CASE
  WHEN enquiry_analysis_status IN ('pending','processing') THEN 'processing'
  WHEN enquiry_analysis_status='complete' AND jsonb_array_length(COALESCE(staff_suggestions,'[]'::jsonb)) > 0 THEN 'suggestion'
  WHEN enquiry_analysis_status='complete' THEN 'shortage'
  ELSE 'need_review'
END;

ALTER TABLE inbound_calls DROP CONSTRAINT IF EXISTS inbound_calls_enquiry_status_check;
ALTER TABLE inbound_calls ADD CONSTRAINT inbound_calls_enquiry_status_check
  CHECK (enquiry_status IN ('processing','need_review','suggestion','shortage','resolved'));

CREATE INDEX IF NOT EXISTS inbound_calls_enquiry_workflow_idx
  ON inbound_calls (organization_id, enquiry_status, started_at DESC);
