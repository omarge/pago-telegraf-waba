# R15 — Payment Engine authoritative reconciliation blocking ledger (read-only)

## Grounded upstream sources, not invented claims

**Repository:** `omarge/businessos-payment-engine`. This document is a cross-repository **READ-ONLY audit**, not permission to change Payment Engine.

### Mainline canonical emission

- `payment-engine-app/src/main/java/com/businessos/payment/app/integration/canonical/SpringCanonicalPaymentEventEmitter.java`, `master` blob `0fefd4a6eeed277eb746133fa5fc3d8164666e17`: emits captured/authorized/failed/unknown/resolved/refunded canonical event facts in the owner state transition transaction.
- `PaymentCanonicalEventRelay.java` blob `b938cd6ea32c5dd588c9982f243145b061e18b9e`: publishes deterministic keyed events to Kafka with `acks=all` and idempotent Kafka producer.
- `PaymentCanonicalEventOutboxRepository.java` blob `1c2fd4aff1966502581148b1fa512650bae062c2`: JPA `findByEventId` and `findByPaymentAttemptId` are **not externally authorized APIs** or PSP reconciliation authority.

### Active CEPR negative-gate evidence

Draft [Payment Engine PR #109](https://github.com/omarge/businessos-payment-engine/pull/109), head `a7c064c51defb0dcb81dc66c6b07f3bd47d35a03`:
- `docs/cepr05/CEPR-R42-real-PAY30-live-owner-finalizer-denial.md`, blob `780555de0193beb8af4910c5e3233115d9414fe2`, explicitly identifies **negative safety gates only**, with P0 #80 and #81 still open and `production_go=NO_GO`.
- `payment-engine-app/src/test/java/com/businessos/payment/app/execution/PostPspOpenpayEvidenceJournalAdversarialTest.java`, blob `bec4babb4aaed8fe7b713b95adc13dd86ac82d52`, tests real PAY30 candidate finalization against live original PSP owner, provider-account identity contradictions and guard epochs. A manufactured `CAPTURED` candidate is denied while the original owner remains DISPATCHING; the test does **not** prove a valid authenticated replacement finalizer or independently authoritative provider receipt.

**Implication:** even a real canonical `PaymentCaptured` event is *not* enough to justify WABA `PAID`, a receipt, a retry, another PSP charge, a webhook or a WhatsApp payment notification. R12–R14 candidate/HOLD controls must remain conservative.

## Required producer-side deliverable before any WABA release

Only after independently certifying Payment Engine's P0 #80 (post-PSP owner exclusion) and #81 (positive economic evidence/finalization) can the Payment Engine team expose an appropriately authenticated read contract. Do **not** invent a URL, provider signature format, claim that a GET already exists, or assert a GREEN payout reconciliation.

A future read contract shall provide at minimum: tenant-scoped authorization; stable paymentId and attemptId; actual PSP/provider account and transaction identity; amount in integral minor units and currency; authoritative capture/UNKNOWN/refund/dispute and economic lifecycle state; source revision and adverse-event high-watermark, including freshness constraints; immutable provider evidence provenance; reconciliation authority; deterministic replay; explicit redaction and audit; fail-closed unavailable/stale/contradictory responses. Owner epoch/guard identity alone does not prove an economic payment.

The **acceptance tests** should demonstrate a real signed/authorized provider fact (not a fixture), original-writer exclusion through crash/recovery, no PAY30 takeover of a live PSP owner, negative contradictory statuses, two concurrent finalizers, unknown->resolved and late refund/dispute, tenant crossover denial, old watermark rejection, provider identity/account swap rejection, and exact-cents match. Release must be gated by exact-SHA independent Security + Payment Engine evidence, not WABA's self-reported JSON.

## Workstreams and dependency relationship

| Workstream | What can proceed independently | GO blocker |
|---|---|---|
| WABA transport | Kafka TLS/SCRAM read-only admin checks, topic **and consumer group** ACL description, independent negative principal tests | No real UAT result or authenticated producer principal proof yet |
| Payment Engine authority | Continue owner exclusion #80 and economic positive finalization #81 in **their own Payment Engine branches** | P0 unresolved per examined PR #109, no independent authorized read model established |
| WABA finance | Candidate capture, UNKNOWN/refund/poison HOLD, exact tenant/payment attempt/cents; no receipt | Needs source-positive provider authority, not event delivery |
| Release | Final single suite on full WABA integration candidate and explicit authorization | `production_go=NO_GO` |

No live broker was queried; no Payment Engine code or status was changed in this audit. No payment/Meta effects or real PSP credentials. All reporting remains source-backed and dated to the inspected source HEAD; this audit does not prove the entire private repository contains no other APIs.
