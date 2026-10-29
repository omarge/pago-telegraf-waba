# R12-G — Unacknowledged Kafka event prevents apparently clean economic capture

**Stacked Draft from certified #49; no production activation or payment authority.**

### Prior gap
R12-E reads canonical ingress and candidate capture rows. If a rejected record was durably recorded in the independent `canonical_kafka_holds` journal, the corresponding economic fact would **not** appear in the accepted ingress. With only a valid capture candidate in accepted records, R12-E could return `CAPTURE_CANDIDATE_RECONCILIATION_PENDING` while an unacknowledged refund, UNKNOWN or contradictory event was blocked on the partition.

### Fix
Within the same PostgreSQL `REPEATABLE READ READ ONLY` snapshot, derive the canonical Kafka key `tenant|paymentIntentId`, compute its SHA-256 and query `canonical_kafka_holds.key_sha256`. **Any HOLD for that exact key immediately yields `INCOMPLETE_INGRESS_HOLD`** rather than the cleaner capture-candidate status. The raw key and payload are never persisted or exposed by this projection. Other tenants and unrelated payment intents are not blocked by this local observation.

The projection remains strictly **`isPaid=false`**, `isReconciled=false`, `canSendReceipt=false`, and is never an authoritative Payment Engine reconciliation API. The absence of held records still cannot prove complete source delivery or final provider capture; Kafka offset gaps, source publisher ACL, provider reconciliation and signed broker completeness remain NO_GO.

Full PostgreSQL18 regression and independent tests include a clean candidate before a held event, exact key hashing, foreign tenant separation, repeated poison delivery, and a later refund. The broker-only test remains isolated in its ephemeral functional job.

**No** main/master change, other BusinessOS repo write, host1, `.env`, real PSP, WhatsApp send, PAID or receipt.
