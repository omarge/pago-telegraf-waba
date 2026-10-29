# R12-C — Canonical noncapture producer identity, independent offline audit

This branch starts from certified Draft PR #41, independently of integration PR #44 (R12-A+B). It alters only the WABA source-decoding rules and offline tests. No real Kafka consumer is activated; no host, secrets, PSP, WhatsApp or main/master changes. `production_go=NO_GO`.

## Verified Payment Engine producer model

The real `SpringCanonicalPaymentEventEmitter` creates deterministic `event_id` from payment attempt and event kind:
- `payment-engine:<attempt>:PaymentAuthorized`
- `payment-engine:<attempt>:PaymentFailed`
- `payment-engine:<attempt>:PaymentRefunded`
- `payment-engine:<attempt>:PaymentExecutionUnknown`
- `payment-engine:<attempt>:PaymentExecutionResolved:EXECUTED|NOT_EXECUTED` (suffix agrees with Protobuf resolution)

The original wire reader validated event ID determinism only for `PaymentCaptured`, even though noncapture records were durably audited and their Kafka offsets could then be committed. This branch rejects forged noncapture identity, cross-attempt `payment_attempt_id`, invalid authorization or unknown status and resolution mismatch BEFORE returning `NON_CAPTURE_EVENT_HOLD`. It never converts any event to `CAPTURED` or `PAID`.

## Evidence

New offline tests cover every real owner-event type, matching header-but-forged event ID, tenant/attempt identity, UNKNOWN status, EXECUTED vs NOT_EXECUTED contradiction and forged authorization/failure statuses. Existing canonical fixture construction is updated to match the real Payment Engine emitter rather than artificial reuse of the PaymentCaptured event ID.

Full PostgreSQL 18 regression required GREEN before promotion.

## Still NO_GO

Transport identity is not cryptographically proven by merely checking Protobuf metadata. The Kafka subscriber and broker ACL/producer authenticity remain separate UAT gates; R12 economic reconciliation/finality and R13 notifications still blocked. PR #44 is independent; an integration verification branch must combine #44 and this patch before UAT.
