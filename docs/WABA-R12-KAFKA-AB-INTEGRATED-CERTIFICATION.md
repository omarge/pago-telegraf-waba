# R12 A+B — Independent-branch integration (offline only)

**Source:** R12-A Draft PR #42 exact SHA `8d2de94d18e4b53c2a11535ca6be9df7528e3873` and R12-B Draft PR #43 exact SHA `a1656738eb6e9ee3b0b10eaf8ca0b668766e893a`, both previously certified GREEN independently.

**Integration technique:** New feature branch created from PR #42. The independently certified source files and migration from PR #43 were copied with Git blob equivalence; the PG test migration allowlist is updated. No merge of #42 or #43, no main/master changes.

## Boundaries

- `createR12RebalanceFencedConsumer` now instantiates the R12-B journal internally, and `createR12HeldRecordProcessor` wraps the existing candidate/audit stage. A rejected record is hashed and retained in `canonical_kafka_holds`, **never acknowledged or skipped**.
- The source remains the real Payment Engine canonical Protobuf contract, **but the broker is fake in CI and no runtime/producer/network integration has been enabled**.
- Kafka manual offsets still advance only on successful durable evidence; `isStale/isRunning` plus local generation invalidation fence every asynchronous boundary.
- The journal stores coordinate + SHA256(payload/key), reason and timestamps only, no raw payload/header, PAN or authentication credentials. It provides a bounded read-only diagnostic API to an operator-facing service port, **not an HTTP route**.
- Invalid/colliding/unbound capture, unknown wire headers, DB errors and restart never release `PAID`, receipts, WhatsApp or financial calls.
- PG18 certification tests both sibling suites and new *integration* failures: bad second record after valid first, same HOLD redelivery after consumer restart, source-payload collision, unbound captures, PostgreSQL HOLD trigger failures, stale partition after durable source and no commit. F06 and WABA menu regression must remain GREEN.

## Gatekeeper NO_GO

A fake Kafka client proves local sequencing, **not** TLS/ACL/producer identity at a genuine broker or multi-node rebalance. There is no authority to skip or quarantine an unbound economic record; a genuine Kafka source may deliver other tenants on the shared topic, and this is an operational head-of-line blocker. An operator-approved per-tenant routing or quarantine policy must be separately certified before UAT. Likewise R12 capture evidence is merely `CANDIDATE_ONLY`; validated reconciliation, Payment Engine production GO and R13 receipts are pending.

No server, `.env`, secret, other BusinessOS repo or master/main changes. Production `NO_GO`.
