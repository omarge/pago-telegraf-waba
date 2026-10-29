# WABA / BusinessOS R12 — authentic canonical Payment wire preflight (OFFLINE)

**Scope:** Draft PR stacked on #39, read-only audit of Payment Engine `master`. Only `omarge/pago-telegraf-waba` is modified. `production_go=NO_GO`.

## Verified *existing* source contract

BusinessOS Payment Engine already has a real economic-event producer, independent of authorization-only REST:

- `payment-engine-app/src/main/java/com/businessos/payment/app/integration/canonical/SpringCanonicalPaymentEventEmitter.java` writes canonical `PaymentAuthorized`, `PaymentCaptured`, `PaymentExecutionUnknown`, `PaymentExecutionResolved`, `PaymentFailed`, `PaymentRefunded` events in the same financial transaction.
- `PaymentCanonicalEventOutbox.java` uses immutable deterministic `event_id`, SHA256 payload, and a durable row for delivery; broker replay can repeat the same business fact.
- `PaymentCanonicalEventRelay.java` sends to Kafka **`businessos.payment.events.v1`** with the original binary Protobuf payload, key `tenant|payment_id`, `content-type=application/x-protobuf`, and certified `businessos-*` headers. A live relay is dark-mode disabled by default; secured SASL/SCRAM configuration/ACLs must be independently provisioned and verified before runtime activation.
- `PaymentExecutionLifecycleCoordinator.emitCanonicalOwnerEvent` sets `payment_id=attempt.intentId().value()`, `meta.source.aggregate_id=attempt.id().value()`; it emits `PaymentCaptured` for `CAPTURED` and `SUCCEEDED` provider outcomes.
- The original authoritative source files `payment.proto` (Git blob `e450bba8a9a11b3a14bc741797fb23d6b163e066`) and `common.proto` (Git blob `ceaf14cd4a1b8ea9d6e86982f2c0420289abc823`) were copied **byte-identically** from Payment Engine `master` into `contracts/businessos/integration/v1/`. Verify their hashes in CI; never modify/fork them to accommodate WABA.

**Important**: an existing durable canonical producer is not the same as a certified WABA subscriber. This PR does NOT grant Kafka ACLs, instantiate consumers, or assert broker authentication, and does NOT turn events into paid receipts.

## Implemented offline adapter

`src/businessosR12CanonicalWireGate.js` decodes real binary `PaymentCaptured` messages using the vendored Protobuf schema and validates:

- exact topic, Kafka key and declared transport headers;
- `meta.producer=payment-engine`, `schema_version=1`, `event_version=1`, tenant, event ID, ordering scope, source aggregate, correlation and causation;
- canonical `payment_id` (the PaymentIntent) and attempt ID from `meta.source.aggregate_id`;
- stable `payment-engine:<attempt>:PaymentCaptured` event identity;
- exact MXN decimal amount converted to integer centavos, without floats, exponent, sub-cent or overflow.

Other event types — authorization, refund, failure, UNKNOWN and resolution — are NOT classified as captured. The injected `verifyTrustedTransport` callback is strictly **offline seam only** and cannot prove source authentication; genuine broker-backed principal and ACL verification must be certified separately.

`src/businessosR12CanonicalCaptureInbox.js` durably records a **candidate-only** signed-canonical-fact result against the original R11 handoff, with a PostgreSQL row lock and precise payer, tenant, intent, attempt, amount, currency and `AUTHORIZED_PENDING_CAPTURE` checks. Replays are idempotent by immutable `event_id` plus `payload_sha256`; same ID with another payload is `CANDIDATE_ID_COLLISION_HOLD`. Strict default is disabled.

`db/waba-r12-canonical-channel.sql` creates an isolated WABA append-only table `canonical_capture_candidates` that **cannot represent** PAID, receipt, delivery, or financial settlement. No BusinessOS database table is changed.

## Operational release blockers

1. Authenticate an actual WABA Kafka consumer and its principal, ACL and topic/key security with a real secured broker. The test `verifyTrustedTransport: async()=>true` **must never** be deployed.
2. Establish replay ordering, recovery on consumers with partition/offset commit only after durable DB commit, quarantine and collision policy, producer schema changes and pinned contract release process.
3. Decide definitive finality: a `PaymentCaptured` event is a **candidate** only; subsequent chargeback, refund, dispute, adverse reconciliation or missing provider evidence can disqualify a customer-visible receipt. The existing R12 read-side gate requires independently verified reconciliation, but is **not connected** to a real read API yet.
4. Test actual R10 canonical CustomerVault/Fraud/Security Engine authorities, real R11 upstream execution, real payment engine production certification, WABA UAT and regulatory receipt semantics.
5. Do not send Meta or PSP messages, no synthetic `PAID`, no auto-retry after UNKNOWN. No hosts, secrets, `.env`, main/master, or other source repos are modified.

## Gatekeeper
PostgreSQL 18 CI executes the complete WABA regression plus real protobuf decoding/headers and candidate durability tests: foreign tenant, attempt or payer, tampered money, malformed proto, duplicate event, different-payload collision, 12 concurrent candidates, UNKNOWN handoff, DB fault, disabled path and 0 outbound effects. Not a UAT/prod certification.
