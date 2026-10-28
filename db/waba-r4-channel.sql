-- WABA / BusinessOS R4. CHANNEL-ONLY data, not a financial ledger.
-- Apply only to an isolated test database; never against BusinessOS schemas.
BEGIN;
CREATE SCHEMA IF NOT EXISTS waba_channel;
CREATE TABLE IF NOT EXISTS waba_channel.requests (
  request_id text PRIMARY KEY CHECK (request_id ~ '^KPR-[A-F0-9]{32}$'),
  requester_wa_id text NOT NULL CHECK (length(requester_wa_id) BETWEEN 8 AND 30),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN' CHECK (currency='MXN'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','BLOCKED')),
  payer_account_id text NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS waba_channel.inbox (
  phone_number_id text NOT NULL,
  message_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('MESSAGE','STATUS_SENT','STATUS_DELIVERED','STATUS_READ','STATUS_FAILED')),
  event_digest char(64) NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (phone_number_id,message_id,event_kind)
);
CREATE TABLE IF NOT EXISTS waba_channel.authorization_reservations (
  request_id text PRIMARY KEY REFERENCES waba_channel.requests(request_id),
  payer_account_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'HOLD_NO_AUTO_RETRY'
    CHECK (state='HOLD_NO_AUTO_RETRY'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMIT;
