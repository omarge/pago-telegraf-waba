# R14-B — Source-backed gap analysis: canonical event delivery ≠ authoritative financial finality

## Read-only evidence examined

Repository **`omarge/businessos-payment-engine`**, ref **`master`**. No source was edited.

| Source file (under `payment-engine-app/src/main/java/com/businessos/payment/app/integration/canonical/`) | Observed Git blob SHA | Verified role |
|---|---|---|
| `SpringCanonicalPaymentEventEmitter.java` | `0fefd4a6eeed277eb746133fa5fc3d8164666e17` | Emits authorized, captured, failed, unknown, resolved and refunded facts inside the owner transaction. `orderingKey` and `correlationId` equal `paymentId`; `causationId` equals `paymentAttemptId` |
| `CanonicalPaymentEventBuilder.java` | `ddf1e26a345bc3b77a2765e66ee2c6946f61d246` | Constructs canonical Protobuf and deterministic event IDs, producer identity `payment-engine` |
| `PaymentCanonicalEventRelay.java` | `b938cd6ea32c5dd588c9982f243145b061e18b9e` | Publishes durable outbox rows to `businessos.payment.events.v1`, Kafka key `tenant|paymentId`, exact canonical header set; Kafka producer idempotence and acks=all |
| `PaymentCanonicalEventOutbox.java` | `9b6835144aad06f44ef4330972f61f5f67195224` | Records the delivery obligation, immutable payload digest, original payment identifiers and delivery status |
| `PaymentCanonicalEventOutboxRepository.java` | `1c2fd4aff1966502581148b1fa512650bae062c2` | `insertIfAbsent` deduplicates event identity via unique event ID, `findPending` republishes pending outbox; exposes `findByEventId` and `findByPaymentAttemptId` as repository methods, **not external authenticated HTTP APIs** |

### What the source **does** prove

An authorized Payment transaction can persist an owner event with a deterministic identifier. The relay transports that event to Kafka, using the canonical Payment identity and Protobuf. A redelivery with the same event ID is not another economic transaction.

### What it **does not** prove

- An outbox record marked **PUBLISHED** is evidence of Kafka delivery, **not bank/PSP settlement**, no refund, a final payment state, or a customer receipt authorization.
- `findByPaymentAttemptId` is a JPA repository method inside Payment Engine, **not a certified cross-service API**, and its outbox status would still be an insufficient source of finality.
- No WABA-accessible, independently authenticated, tenant-scoped reconciliation query with captured/reversed/disputed current status and a provider-backed proof was verified from these files.
- WABA cannot infer that absence of a `PaymentRefunded` event guarantees no refund. It may be pending, delayed, failed to publish or outside the consumer's observed revision.

## Minimum authority contract required for a future real integration

Owner: BusinessOS Payment Engine, not WABA, Telegram or an arbitrary bot callback. A genuine API should be specified by the Payment Engine team and independently reviewed; **no endpoint, URL, token or signature format is invented here**.

1. Authenticated tenant-scoped read of authoritative **current attempt + payment lifecycle**, with stable `paymentId` and `paymentAttemptId`, provider transaction reference and immutable amount/currency.
2. Economic proof that capture was executed by the actual PSP and reconcile result has no unresolved UNKNOWN/indeterminate provider outcome. A local `Captured` Kafka candidate alone is not a finality attestation.
3. Atomic cross-source status or a verifiable revision/watermark spanning capture, reversal/refund/dispute, including a documented freshness bound and fail-closed behavior on lag.
4. Provider fact provenance and trust: how the API validates PSP evidence, replay/idempotency, version and signature/identity, and how authorization to WABA is scoped.
5. Negative tests: partial provider response, late refund, concurrent chargeback, unresolved UNKNOWN, different tenant, different attempt, captured amount mismatch, stale watermark, source outage and conflicting event revisions.
6. A separate, explicitly approved **GO** is required to turn any successful reconciliation read into a paid notification or customer receipt.

## Integration stop conditions

If the authentic endpoint, documented auth mechanism, provider evidence provenance or watermark semantics are missing, WABA must remain `NO_GO`. R13-CD already returns HOLD for any self-reported claim, including a perfect one. Do not weaken that behavior to close a certification issue.

This is a **source-backed design and audit artifact**, not a fake API implementation or a production safety certification. Other BusinessOS repositories were read-only; no SQL, host1, environment secrets, PSP, Meta or live broker was accessed.

## CI cost

Only Markdown is changed in this branch. **No GitHub Actions regression should be requested**. The previous R13-CD focused **21/21 PASS** evidence remains valid for the unchanged application code.
