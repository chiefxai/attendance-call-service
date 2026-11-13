UPDATE organization_call_settings
SET settings = jsonb_set(
  jsonb_set(
    COALESCE(settings, '{}'::jsonb),
    '{callRetry}',
    COALESCE(settings->'callRetry', '{}'::jsonb) || '{"initialMinutes":3}'::jsonb,
    TRUE
  ),
  '{unansweredCallEscalation}',
  '"call_care_manager"'::jsonb,
  TRUE
), updated_at = NOW()
WHERE settings IS NOT NULL;
