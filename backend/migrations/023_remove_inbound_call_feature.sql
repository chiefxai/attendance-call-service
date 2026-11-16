-- Remove the unused inbound patient-call and enquiry workflow.
-- Patient directory records remain in use by attendance schedules.
DROP TABLE IF EXISTS appointment_call_attempts;
DROP TABLE IF EXISTS inbound_calls;
DROP TABLE IF EXISTS care_activities;
DROP INDEX IF EXISTS patient_directory_phone_lookup_idx;

UPDATE organization_call_settings
SET settings = settings - 'allowInboundCalls'
                       - 'allowNonPatientInboundCalls'
                       - 'requireHumanVerificationForStaffBooking',
    updated_at = NOW()
WHERE settings ? 'allowInboundCalls'
   OR settings ? 'allowNonPatientInboundCalls'
   OR settings ? 'requireHumanVerificationForStaffBooking';
