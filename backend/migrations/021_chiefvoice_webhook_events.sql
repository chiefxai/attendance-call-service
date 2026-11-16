CREATE TABLE IF NOT EXISTS chiefvoice_webhook_events (
  event_id TEXT PRIMARY KEY,
  provider_call_id TEXT,
  event_type TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chiefvoice_webhook_events_received_at_idx
  ON chiefvoice_webhook_events(received_at);
