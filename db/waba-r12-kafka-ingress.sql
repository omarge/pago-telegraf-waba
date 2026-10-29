-- R12: authenticated Kafka adapter staging only; NOT a financial ledger.
-- No offsets are committed until the event decision is durable.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.canonical_kafka_ingress (
 event_id text NOT NULL,
 payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 topic text NOT NULL CHECK(topic='businessos.payment.events.v1'),
 partition_id integer NOT NULL CHECK(partition_id>=0),
 record_offset bigint NOT NULL CHECK(record_offset>=0),
 event_type text NOT NULL CHECK(event_type IN
  ('PaymentCaptured','PaymentAuthorized','PaymentFailed','PaymentRefunded',
   'PaymentExecutionUnknown','PaymentExecutionResolved')),
 tenant_id text NOT NULL,
 payment_intent_id text NOT NULL,
 payment_attempt_id text NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('CAPTURE_CANDIDATE_ONLY','NON_CAPTURE_HOLD')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(topic,partition_id,record_offset)
);
CREATE INDEX IF NOT EXISTS r12_kafka_ingress_event_id
 ON waba_channel.canonical_kafka_ingress(event_id);
CREATE INDEX IF NOT EXISTS r12_kafka_ingress_tenant_attempt
 ON waba_channel.canonical_kafka_ingress(tenant_id,payment_attempt_id,created_at);
COMMIT;
