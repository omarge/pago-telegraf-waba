# R12 — Kafka rebalance / stop epoch fencing (OFFLINE ONLY)

Stacked Draft on PR #41, `production_go=NO_GO`. The alternative `createR12RebalanceFencedConsumer` is **not mounted** by the WABA runtime, does not connect to real brokers in CI, and never marks `PAID`, dispatches payments, or sends WhatsApp.

The KafkaJS consumer uses TLS with certificate validation, SASL/SCRAM-512, no auto topic creation, **autoCommit=false** and **eachBatchAutoResolve=false**, a single partition-processing slot, and manually commits each offset only AFTER the existing PostgreSQL candidate and delivery audit transactions. The callback checks `isRunning()`, `isStale()` and a local epoch before processing, after DB persistence and after the heartbeat. `stop()` revokes the local epoch synchronously before awaiting async teardown. A stale or stopped batch never resolves or commits the offset. A lost Kafka ack must replay the same durable fact idempotently.

An unexpected negative/overflow/descending offset is held; Kafka record offset must be below max signed int64 because commit uses the successor. The scheme allows compacted/skipped offsets but refuses decreasing or repeated positions **inside a single batch**.

PostgreSQL 18 tests certify fake-consumer stop/rebalance, stale before and after DB commit, aborted broker commit replay, malformed second event, monotonicity, 64-bit bound and all existing WABA regressions. No genuine consumer group, broker rebalance, TLS trust chain, producer ACL, multi-node failover or Kafka transport was tested. `main`, `master`, `.env`, other repositories and host1 untouched.

**Promotion blockers:** independent broker principal/ACL/producer evidence, KafkaJS true broker rebalance & disconnect matrix, operational held-record policy, Payment Engine GO, economic reconciliation/finality and UAT. No R13 receipt authorization.
