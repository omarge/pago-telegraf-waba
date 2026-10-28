-- R7: channel-only dispatch decisions; ABSOLUTELY NO external side effects.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.routing_decisions (
 phone_number_id text NOT NULL,
 message_id text NOT NULL,
 event_kind text NOT NULL,
 event_digest char(64) NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
 source_envelope_digest char(64) NOT NULL REFERENCES waba_channel.signed_envelopes(envelope_digest),
 route_code text NOT NULL CHECK (route_code IN
  ('MENU_CANDIDATE','AWAITING_SECURITY_ENGINE','IGNORED_STATUS',
   'IGNORED_UNKNOWN','REQUIRES_REVIEW')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(phone_number_id,message_id,event_kind),
 FOREIGN KEY(phone_number_id,message_id,event_kind)
  REFERENCES waba_channel.normalized_inbox_events(phone_number_id,message_id,event_kind)
);
CREATE INDEX IF NOT EXISTS routing_decisions_r7_candidates
 ON waba_channel.routing_decisions(route_code,created_at)
 WHERE route_code IN ('MENU_CANDIDATE','AWAITING_SECURITY_ENGINE');
COMMIT;
