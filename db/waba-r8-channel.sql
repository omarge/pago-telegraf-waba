-- R8: channel-only, opt-in, at-most-once SAFE MENU response outbox.
-- Financial routes cannot be scheduled here. No BusinessOS schema changes.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.safe_menu_outbox (
 outbox_key char(64) PRIMARY KEY CHECK (outbox_key ~ '^[a-f0-9]{64}$'),
 phone_number_id text NOT NULL,
 message_id text NOT NULL,
 event_kind text NOT NULL DEFAULT 'MESSAGE' CHECK (event_kind='MESSAGE'),
 source_envelope_digest char(64) NOT NULL REFERENCES waba_channel.signed_envelopes(envelope_digest),
 event_digest char(64) NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'READY'
  CHECK (state IN ('READY','UNKNOWN_HOLD','PROVIDER_ACCEPTED')),
 provider_message_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reserved_at timestamptz,
 accepted_at timestamptz,
 UNIQUE(phone_number_id,message_id,event_kind),
 FOREIGN KEY(phone_number_id,message_id,event_kind)
  REFERENCES waba_channel.routing_decisions(phone_number_id,message_id,event_kind),
 CHECK (
  (state='READY' AND reserved_at IS NULL AND provider_message_id IS NULL AND accepted_at IS NULL) OR
  (state='UNKNOWN_HOLD' AND reserved_at IS NOT NULL AND provider_message_id IS NULL AND accepted_at IS NULL) OR
  (state='PROVIDER_ACCEPTED' AND reserved_at IS NOT NULL AND provider_message_id IS NOT NULL AND accepted_at IS NOT NULL)
 )
);
COMMIT;
