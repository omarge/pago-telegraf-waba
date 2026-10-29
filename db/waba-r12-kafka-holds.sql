-- R12 HOLD-only diagnostics for an unacknowledged Kafka record. No skip / DLQ.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.canonical_kafka_holds (
 topic text NOT NULL CHECK (topic='businessos.payment.events.v1'),
 partition_id integer NOT NULL CHECK(partition_id>=0),
 record_offset bigint NOT NULL CHECK(record_offset>=0),
 payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 key_sha256 char(64) NOT NULL CHECK(key_sha256 ~ '^[0-9a-f]{64}$'),
 reason text NOT NULL CHECK(reason IN
 ('INVALID_COORDINATE_HOLD','UNVERIFIED_CANONICAL_HOLD','UNBOUND_OR_AMBIGUOUS_CAPTURE_HOLD',
  'DB_UNAVAILABLE_NO_EFFECT','CAPTURE_INBOX_UNAVAILABLE_HOLD','CAPTURE_INBOX_REJECTED_HOLD',
  'EVENT_ID_OR_OFFSET_COLLISION_HOLD','UNVERIFIED_EVENT_HOLD')),
 state text NOT NULL DEFAULT 'HELD' CHECK(state='HELD'),
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 observations integer NOT NULL DEFAULT 1 CHECK(observations>=1),
 PRIMARY KEY(topic,partition_id,record_offset)
);
COMMIT;
