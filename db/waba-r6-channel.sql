-- R6: internal durable normalization only. No external side effects.
BEGIN;
ALTER TABLE waba_channel.signed_envelopes
  ADD COLUMN IF NOT EXISTS normalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantined_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_code text;
CREATE TABLE IF NOT EXISTS waba_channel.normalized_inbox_events (
  phone_number_id text NOT NULL,
  message_id text NOT NULL,
  event_kind text NOT NULL,
  event_digest char(64) NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  source_envelope_digest char(64) NOT NULL
    REFERENCES waba_channel.signed_envelopes(envelope_digest),
  normalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (phone_number_id,message_id,event_kind)
);
CREATE INDEX IF NOT EXISTS signed_envelopes_r6_ready_idx
  ON waba_channel.signed_envelopes(received_at,envelope_digest)
  WHERE normalized_at IS NULL AND quarantined_at IS NULL;
COMMIT;
