# R16 — Narrow Kafka ACL scope hardening + source-backed upstream P0 release blockers

## Why this change, rather than another full regression

R15 targeted Node24 [#40819458027](https://github.com/omarge/pago-telegraf-waba/actions/runs/40819458027) certified 29 offline tests. Source inspection of the *actual* R14 Kafka probe identified two untested faults:

1. A successful `admin.describeAcls` that returned **a nonempty policy for a different topic or consumer group** was previously labeled `BROKER_METADATA_OBSERVED_PENDING_INDEPENDENT_AUDIT`. Even though this status was not GO, it overstated the relevance of the observation.
2. A KafkaJS `admin.connect()` that rejected after creating connection resources would not call `admin.disconnect()` because the previous cleanup depended on `connected=true`.

The R16 patch now requires a nonempty ACL resource **exactly matching the canonical topic and configured consumer group** before returning a policy-observed status. A mismatched resource produces `ACL_RESOURCE_SCOPE_NOT_PROVEN_HOLD`. This intentionally rejects wildcard/prefix-only policies as insufficient local evidence; the independent Kafka security team must verify effective ACLs and actual allow/deny with approved principals. Cleanup attempts disconnect whenever an admin instance exists, even after partial connection failure. This is best-effort, not a guarantee that an external broker has released every connection.

Three new adversarial fake-admin cases exercise foreign topic, foreign group and failed connect cleanup. They are added to the EXISTING `tests/businessos-r13-kafka-readonly-probe.test.js`, picked up by the existing **one-job** Node24 targeted workflow; **no DB, broker, Docker or full regression** requested. The probe remains disabled by default and unmounted.

## Fresh read-only upstream issue verification (2026-10-29 UTC)

The following issue states were read directly from connected GitHub, not inferred from prior summaries:

| Owner | Issue | Current open gate | Required positive certificate |
|---|---|---|---|
| Payment Engine | [#80](https://github.com/omarge/businessos-payment-engine/issues/80) | Legitimate original PSP owner **exclusion** before post-PSP takeover; an expired lease, heartbeat or GET observation alone does not revoke the original owner | Durable proof that an old, partitioned/reconnected JVM **cannot write any financial row** after authorized handoff |
| Payment Engine | [#81](https://github.com/omarge/businessos-payment-engine/issues/81) | Immutable, independent PSP economic evidence and all-row atomic orphan finalization; GET `CORROBORATED_CANDIDATE` is not settlement proof | Provider-backed, tenant/account/order/transaction/amount proof bound to a valid #80 authority token, with refund/UNKNOWN contradictory cases |
| Payment Engine | [#13](https://github.com/omarge/businessos-payment-engine/issues/13) | `PaymentCaptured` v1 lacks owner-authenticated `merchantId/legalEntityId` binding | A versioned Payment/Merchant/Subledger identity contract and joint negative tests; **never** derive legalEntityId from paymentAttemptId/source.aggregateId |
| Merchant Engine | [#10](https://github.com/omarge/businessos-merchant-engine/issues/10) | Merchant→Legal Entity association needs tenant-authenticated effective-time selection and single-valid-association handling | Immutable issuer, tenant, merchant, legal entity, association version, validity/effective time and proof; ambiguous or cross-tenant binding HOLD |

The canonical Payment Engine emitter, relay and outbox were previously examined read-only. They establish deterministic lifecycle event publication, **not PSP economic finality or merchant legal identity**. A WABA projection cannot legitimately repair source owner authority by synthesizing an event payload or accepting self-reported evidence.

### Explicit release dependency order

1. Maintain WABA source-candidate/HOLD-only, no `PAID`, receipt, webhook or WhatsApp payment notification.
2. Certify Payment Engine #80 owner-exclusion and #81 provider-economic positive authority in **Payment Engine's own isolated development branches**; no WABA writes can substitute for this.
3. Certify Payment #13 plus Merchant #10 authentic, versioned and tenant-scoped legal entity binding before any positive ledger posting.
4. Provision and independently validate real Kafka secure UAT TLS/SCRAM, exact topic+group effective ACLs, producer and denied principals. R16 probe does NOT execute any live broker request and returns NO_GO regardless of results.
5. After source owners produce actual authority contracts and evidence, conduct one controlled end-to-end financial UAT with explicitly approved secrets. Only a separately certified future release may consider a payment receipt.

### Scope

One WABA **Draft** branch only. No `main`/`master`, no host1, `.env`, passwords or personal finance data, no other repository writes, no live broker, PSP or Meta operations. `production_go=NO_GO`. No new costly CI workflows.
