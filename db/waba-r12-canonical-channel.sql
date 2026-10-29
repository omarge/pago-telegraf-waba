-- R12: channel-side candidate evidence ONLY; no paid status or receipt authority.
-- Source: Payment Engine canonical businessos.payment.events.v1 proto Kafka.
-- Run only on an isolated test database until explicit deployment authorization.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.canonical_capture_candidates (
 event_id text PRIMARY KEY,
 payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 request_id text NOT NULL REFERENCES waba_channel.payment_authorization_handoffs(request_id),
 tenant_id text NOT NULL,
 payment_intent_id text NOT NULL,
 payment_attempt_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency char(3) NOT NULL CHECK(currency='MXN'),
 evidence_state text NOT NULL DEFAULT 'CANDIDATE_ONLY' CHECK(evidence_state='CANDIDATE_ONLY'),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,payment_attempt_id)
);
CREATE INDEX IF NOT EXISTS r12_capture_candidates_request_idx
 ON waba_channel.canonical_capture_candidates(request_id,observed_at);
COMMIT;
