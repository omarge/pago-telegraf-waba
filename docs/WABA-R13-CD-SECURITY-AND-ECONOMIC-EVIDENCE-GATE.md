# R13 C+D combined evidence authority gate — OPEN UAT blockers

## Exact input lineage

This feature branch is created from independent Draft **PR #59** (Kafka security evidence), source HEAD `e2608fdeaf5467db96e7f39ee265a88fce6ed499`, and copies the independently reviewed module, tests and documentation from sibling Draft **PR #60** (economic coverage), source HEAD `3b99a55856191f7aac243c682c31ea63a1534554`. Both are stacked on certified Draft **PR #58** R13-A+B (10 PASS / 0 FAIL, targeted-only GitHub Action). None are merged to main/master.

**Producer source read-only inspection**: `omarge/businessos-payment-engine/master`, `PaymentCanonicalEventRelay.java`, `SpringCanonicalPaymentEventEmitter.java`, `CanonicalPaymentEventBuilder.java`. These contain the owner `payment-engine`, topic `businessos.payment.events.v1`, durable canonical outbox and deterministic event IDs. They do NOT establish secured UAT Kafka ACL results or an authenticated, WABA-accessible reconciled-capture read model.

## Implemented safeguards

- R13-C `reviewR13KafkaAclEvidence`: passively reviews nine alleged broker ACL allow/deny results (producer WRITE, WABA consumer READ/DESCRIBE & GROUP READ, outsider denies, no consumer WRITE or producer group READ), principal segregation and claimed TLS/SCRAM login, without copying credentials. **Self-report only.**
- R13-D `reviewR13EconomicEvidenceCoverage`: passively verifies matching tenant/intent/attempt, MXN integer cents, claimed provider capture and reconciliation, signed-64-bit decimal source/capture/adverse-event watermarks and zero unknown/refund/dispute pending indicators. **Self-report only.**
- R13-C+D `reviewR13EvidenceCompleteness`: combines the existing R13 A+B source-independent shape gate with C and D. Even completely self-consistent claims return **`UNVERIFIED_EVIDENCE_SHAPES_COMPLETE_HOLD`**. All outcomes keep `isPaid=false`, `canSendReceipt=false`, `canSendWhatsApp=false`, `mayCommitKafkaOffset=false`, `canConnectLive=false`, `productionGo=false`.

## CI budget

Reuses the **single** existing `.github/workflows/waba-businessos-r13-ab-targeted.yml` lightweight Node 24 job, broadened to `node --test tests/businessos-r13-*.test.js`. No `npm install`, PostgreSQL 18, Kafka, Docker, PSP, Meta network or broad R12 regressions. The total is 3 A + 3 B + 4 A+B + 4 C + 4 D + 3 C+D = **21 focused tests** on the exact final integration SHA. No new expensive workflow was added.

## Remaining blockers (do not infer GO)

- Inspect actual live UAT Kafka broker TLS CA/hostname, SCRAM-512 principal login, topic and group ACL allow/deny tests with separate producer/consumer identities; review evidence independently. The code here never connects to or authenticates a broker.
- Locate and certify the original BusinessOS Payment Engine's authenticated, tenant-scoped, provider-reconciled capture read model; its source revision, causal high-watermark and refund/UNKNOWN/dispute completion semantics must be auditable. No such endpoint was assumed or invented.
- Certify actual payment/provider capture authority and UAT separately before R13 customer receipt, PAID or any WhatsApp notification.

All changes live exclusively in this WABA Draft branch. No main/master, host1, secrets, `.env`, other repo mutations, real PSP actions or Meta sends. `production_go=NO_GO`.
