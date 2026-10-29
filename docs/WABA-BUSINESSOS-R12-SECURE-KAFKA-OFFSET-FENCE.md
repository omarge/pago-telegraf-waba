# R12 — Secure Kafka offset fencing, OFFLINE certification only

## Actual source and contract

`omarge/businessos-payment-engine/master` is read-only. Its `PaymentCanonicalEventRelay` publishes canonical protobuf messages to `businessos.payment.events.v1` keyed by `tenant|payment_id`. `SpringCanonicalPaymentEventEmitter` owns the durable financial outbox. WABA has vendored byte-identical canonical `payment.proto` and `common.proto`, hash-gated in CI.

## Implementation
- `src/businessosR12SecuredKafkaConsumer.js`: **not wired into WABA startup**. Opt-in secure KafkaJS client, fixed exact topic, no automatic topic creation, TLS server certificate validation, SASL/SCRAM-512 only, explicit external credentials, no insecure default or localhost fallback. `autoCommit=false`, `partitionsConsumedConcurrently=1`. `consumer.commitOffsets` is called **only after** the durable PG handler returns `mayCommit:true`.
- `src/businessosR12KafkaCommitProcessor.js`: validates original canonical Protobuf via R12 wire gate. PaymentCaptured requires a **unique** pre-existing R11 handoff matching tenant, intent, attempt, positive MXN exact amount and bound payer. It calls the previous candidate-only inbox. BusinessOS authorization, failure, refund, UNKNOWN and resolution events receive an **audited NON_CAPTURE_HOLD** disposition and never create PAID or a receipt. Malformed, mismatched, ambiguous or unbound PaymentCaptured are held and **not acknowledged**.
- `db/waba-r12-kafka-ingress.sql`: immutable durable event and delivery audit by topic/partition/offset, event ID, payload SHA256, tenant, attempt and disposition. A single canonical fact may be retransmitted at *another* offset by the Payment Engine relay: the same event ID and the same SHA are allowed; different SHA or identity is a collision. The per-event PostgreSQL transaction advisory lock fences concurrent collision checks. `canonical_capture_candidates` remains **CANDIDATE_ONLY**.
- Source and delivery are distinct: **event_id identifies a canonical economic fact**, while `(topic,partition,offset)` identifies a Kafka delivery. Duplicate of a fact is not a new financial event; duplicate delivery cannot trigger an additional capture.
- Two durable transactions are deliberately separate (capture candidate, then delivery audit). A crash after candidate COMMIT but before audit COMMIT leaves no Kafka offset commit and is safely replayed against the idempotent candidate inbox.

## Security and remaining production blockers

The KafkaJS client config is ready to be integrated later but is **never activated by this PR**. No broker was contacted in CI; connection and message delivery use a fake Kafka driver with a genuine PostgreSQL 18 backend. The `verifyTrustedTransport` callback is true only after `consumer.connect()` within this adapter; **connection alone cannot prove broker ACLs, Payment Engine producer ownership, topic authorization, or genuine TLS trust at UAT**. Those require separate certified external broker tests, provisioned credentials and permission review. The code must not be mounted until then.

A missing/foreign PaymentCaptured stays unacknowledged and blocks partition progress; do not automatically quarantine or skip economic facts to improve throughput. An operator-approved discovery/reconciliation and poison handling policy is needed for the mixed tenant topic. Noncapture events are durably audited as HOLD, not economically reconciled. The adapter is not a full cross-event state reducer; event ordering across partitions, partition rebalances, backpressure, cancellation, revoked credentials, consumer-group deployments and source producer ACLs remain UAT gates.

Critically: **captured candidate is NOT PAID**. No R13 message, proof of final settlement, chargeback/refund release, actual CustomerVault/Fraud/Security authority, production Payment Engine GO, or real network communication has been certified.

No edits to `main/master`, other BusinessOS repos, `.env`, host1, UAT or production. No Meta, PSP or bank side effects. `production_go=NO_GO`.

## Test matrix
Offline GitHub Actions:  PostgreSQL 18 and fake secure Kafka client, malformed/wrong topic or headers, missing credentials, TLS config, no auto-commit, exact 64-bit offset increment, candidate-before-offset, repeated same delivery, republished identical fact at new offset, forged content at new offset, noncapture durable HOLD, foreign unbound capture blocked, crash after candidate commit before delivery audit, replay after recovery and full prior regression. A GREEN on this test matrix means **offline adapter certified**, not live Kafka authentication certified.
