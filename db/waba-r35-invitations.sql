-- WABA-only durable invitations; no BusinessOS ledger or PSP state.
BEGIN;
CREATE SCHEMA IF NOT EXISTS waba_channel;
CREATE TABLE IF NOT EXISTS waba_channel.invitation_claims (
 token_sha256 char(64) PRIMARY KEY CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
 requester_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 request_id text UNIQUE CHECK(request_id ~ '^KPR-[A-F0-9]{32}$'),
 CHECK(expires_at>created_at),
 CHECK((consumed_at IS NULL AND request_id IS NULL) OR (consumed_at IS NOT NULL AND request_id IS NOT NULL))
);
COMMIT;
