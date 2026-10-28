-- R5: additive, isolated channel tables. No BusinessOS financial schema changes.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.payer_claims (
  request_id text PRIMARY KEY REFERENCES waba_channel.requests(request_id),
  challenge_hash char(64) NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS waba_channel.signed_envelopes (
  envelope_digest char(64) PRIMARY KEY CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  tag bytea NOT NULL CHECK (octet_length(tag)=16),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext)>0 AND octet_length(ciphertext)<=65536),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMIT;
