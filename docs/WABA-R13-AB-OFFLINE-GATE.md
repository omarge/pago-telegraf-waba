# R13 A+B — Offline Kafka and economic-authority readiness gate

## Provenance and execution boundaries

This branch starts from Draft PR #54 exact head `c6d7e00d6085552f7c2054bce1c53538732d3359` and copies byte-for-byte the independent source, test and documentation blobs from Draft PR #55 exact head `6de70e416c4b0193f434bbec4b629e987031a27c`. Neither PR is merged. Base chain includes Draft #53 Actions budget remediation and the independently certified R12 F+G Draft #52.

Read-only inspection of `omarge/businessos-payment-engine/master` confirmed:
- `PaymentCanonicalEventRelay.java` emits canonical Protobuf to `businessos.payment.events.v1` using deterministic tenant/payment key and exact transport headers. It is dark by default.
- `SpringCanonicalPaymentEventEmitter.java` creates durable canonical economic lifecycle events in the same transaction as owner-authoritative state changes.
- `CanonicalPaymentEventBuilder.java` derives deterministic event identities.

**This source inspection does not prove** a WABA-accessible authenticated reconciliation read API exists. Nor does it prove a WABA SCRAM principal, ACL or TLS trust relationship at any live Kafka broker.

## What has actually been implemented

`assessR13KafkaDeployment` checks only the presence/shape of broker URLs, TLS certificate verification configuration, SCRAM-SHA-512, expected principal/group, manual offset processing and absence of test constructor override. It does not establish a network connection. Its best outcome is `CONFIG_SHAPE_ONLY`.

`reviewR13ReconciliationClaim` checks only a claimed payer/intent/attempt, exact amount/currency, capture/refund/UNKNOWN fields and alleged source/proof status. Even its best outcome is `CLAIM_SHAPE_ONLY_NO_FINALITY` because a caller could fabricate all fields.

`reviewR13OfflineReadiness` combines both without doing any I/O. Even when both shapes are perfect, the response is **`OFFLINE_SHAPES_READY_UNTRUSTED_HOLD`** with `isPaid=false`, `canSendReceipt=false`, `canSendWhatsApp=false`, `mayCommitKafkaOffset=false`, `canConnectLive=false` and `productionGo=false`.

## Minimal CI budget and test plan

Exactly one new targeted GitHub Actions job uses Node.js 24 and runs the two existing three-test files plus four new cross-boundary cases. No `npm install`, PostgreSQL, Docker, Kafka or PSP. It is triggered on PR changes to R13 source/test files, not on every push. Existing F06/menu automatic checks may run independently. Do not rerun full R12 PG18 or ephemeral broker suites for this source-isolated zero-I/O change.

## Required future proof to move beyond NO_GO

- **Kafka:** mutually trusted broker TLS/CA and hostnames, SCRAM principal identity, ACL READ/consumer group and denial to impostor principals/producers, failover and offset/rebalance evidence on the actual authorized UAT environment.
- **Finance:** discover/implement a genuine read-only, tenant-scoped Payment Engine reconciliation contract with authoritative captured/provider-fact evidence; verify source revision, provider transaction and amount, refund/UNKNOWN/dispute completeness and bounded freshness. A claim with `MATCHED` cannot itself be promoted to `PAID`.
- **Operational:** signed reviewed release and controlled UAT; only then discuss separate R13 receipt notification certification.

No real payments, Meta sends, host1, secrets, `.env`, other repository mutations, `main`/`master` writes or merges. `production_go=NO_GO`.
