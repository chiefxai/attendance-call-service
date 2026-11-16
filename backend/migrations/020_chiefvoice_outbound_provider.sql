-- ChiefVoice is the provider for newly placed outbound attendance calls.
-- Existing rows retain their recorded provider so historical callbacks remain attributable.
ALTER TABLE attendance_call_attempts ALTER COLUMN provider SET DEFAULT 'chiefvoice';
