# R13-D — Economic causal completeness and watermark evidence (PASSIVE, NOT FINALITY)

Source audit read-only: Payment Engine canonical emitter stores economic facts transactionally in outbox and relays the Protobuf events. WABA currently has a bounded local candidate inbox and read-only reversal/HOLD projection, but no independently verified provider-authoritative reconciliation read API has been established.

`reviewR13EconomicEvidenceCoverage` reviews **self-reported** economic observations. Input requires exact tenant, payment intent/attempt, PSP transaction and reconciliation IDs, MXN amount in integer cents, claimed captured + matched result, provider evidence ID, producer name `payment-engine`, alleged source-authenticated snapshot and a UAT run ID. Crucially, `captureRevision`, `authoritativeWatermark`, `adverseEventsWatermark` are signed 64-bit decimal strings; capture must not exceed the source watermark, and adverse-event coverage must not lag it. Unknown/refund/dispute pending counts must all be exactly zero.

This prevents calling an obviously stale or incomplete *claim* clean. It does not prove a read model exists, verify provider signatures, ensure Kafka exactly-once owner authority, or guarantee events never arrive late. Even a perfect alleged set returns `SELF_REPORTED_COVERAGE_HOLD`, always `isPaid=false`, `canSendReceipt=false`, `isReconciled=false`, `productionGo=false`. There is no financial side effect and no legitimate reconciliation release.

**Real next gate**: discover or implement a tenant-scoped authenticated Payment Engine query with verifiable revision/watermark and confirmed provider capture/reconciliation, then independently certify refund, dispute, UNKNOWN and crash recovery completeness. Do not invent a URL or claim to have seen a successful PSP capture.

**CI budget**: no new workflow or full regression for the isolated zero-I/O module; four focused Node tests to run with R13-C integration. Previous R12 and R13 A+B GREEN evidence retained, no master/main or deployment edits.
