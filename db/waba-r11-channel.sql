-- R11: WABA channel evidence/fence. NOT financial ledger or PSP authority.
-- Depends on R4 waba_channel.authorization_reservations; never alters BusinessOS.
BEGIN;
CREATE TABLE IF NOT EXISTS waba_channel.payment_authorization_handoffs (
 request_id text PRIMARY KEY REFERENCES waba_channel.requests(request_id),
 payer_account_id text NOT NULL,
 tenant_id text NOT NULL,
 customer_id text NOT NULL,
 fraud_assessment_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency char(3) NOT NULL DEFAULT 'MXN' CHECK(currency='MXN'),
 idempotency_key text NOT NULL UNIQUE,
 authority_fingerprint char(64) NOT NULL CHECK(authority_fingerprint ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL DEFAULT 'UNKNOWN_HOLD'
  CHECK(outcome IN ('UNKNOWN_HOLD','AUTHORIZED_PENDING_CAPTURE','DECLINED','PRE_EXECUTION_FAILED','DENIED')),
 businessos_intent_id text,
 businessos_attempt_id text,
 reserved_businessos_intent_id text,
 reserved_businessos_attempt_id text,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finalized_at timestamptz,
 CHECK(
  (outcome='UNKNOWN_HOLD' AND finalized_at IS NULL) OR
  (outcome<>'UNKNOWN_HOLD' AND finalized_at IS NOT NULL)
 )
);
-- Existing channel UAT schemas may predate R20; preserve historic rows.
-- New R11 reservations commit a deterministic economic binding BEFORE POST.
ALTER TABLE waba_channel.payment_authorization_handoffs
 ADD COLUMN IF NOT EXISTS reserved_businessos_intent_id text;
ALTER TABLE waba_channel.payment_authorization_handoffs
 ADD COLUMN IF NOT EXISTS reserved_businessos_attempt_id text;
-- Unique across ALL non-null reservations, including UNKNOWN_HOLD. Do not
-- release an original PSP attempt simply because its response is unknown.
CREATE UNIQUE INDEX IF NOT EXISTS r20_handoffs_tenant_reserved_intent_uq
 ON waba_channel.payment_authorization_handoffs
 (tenant_id,reserved_businessos_intent_id)
 WHERE reserved_businessos_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS r11_handoffs_unresolved_idx
 ON waba_channel.payment_authorization_handoffs(reserved_at)
 WHERE outcome='UNKNOWN_HOLD';
COMMIT;
