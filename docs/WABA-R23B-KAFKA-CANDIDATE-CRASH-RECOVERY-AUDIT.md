# R23-B — Candidate + Kafka audit crash recovery, source-backed gap review

## Proven behavior on R22 certified head

Read-only source: WABA Draft PR #72, commit `24a471b358134cec372f5eb25579c5ff6b28cafd`.

- `src/businessosR12KafkaCommitProcessor.js`: the canonical record is validated; for `PaymentCaptured` the processor checks unique authorized handoff and original reserved economic identity, calls `captureInbox.persistCandidate()`, then calls `audit()`. Only after **both** return accepted durable states does `process()` expose `mayCommit:true`. No PSP, ledger or Meta action is executed.
- `src/businessosR12CanonicalCaptureInbox.js`: candidate is stored in `canonical_capture_candidates` via a separate `BEGIN` / `COMMIT`, under handoff/request locks. It remains **CANDIDATE_ONLY**, with no PAID.
- `src/businessosR12KafkaCommitProcessor.js`: Kafka ingress `canonical_kafka_ingress` is audited in a second DB transaction, with same-event advisory lock, idempotent offset-key row and conflicting-payload denial. The consumer may commit the offset only after this durable audit.
- `src/businessosR12RebalanceFencedConsumer.js`: after DB work and each heartbeat, checks epoch, assignment and stale state before Kafka offset commit. It explicitly disables auto-commit and automatic batch resolution.
- `src/businessosR12KafkaHoldJournal.js`: failed/held records may be independently journaled for investigation, without offset-commit authority.

## Already verified adversarial recovery scenarios

These are existing tests, not invented new results:
- `tests/businessos-r12-secure-kafka-offset.test.js`, **"crash after candidate commit before audit"**: forces a PostgreSQL trigger to reject audit insertion; candidate remains durable, **zero offsets committed**, then removes failure and replays the same record; one candidate remains and one Kafka offset can be committed after audit.
- Same file, **"replay same offset and same event at new offset"**: preserves one candidate under identical deliveries and persists distinct Kafka offset audit rows.
- `tests/businessos-r12-kafka-rebalance-fencing.test.js`, **"lost Kafka commit ACK"**: persisted ingress row is reprocessed after a simulated Kafka commit failure; no second financial action.
- Same file, **"stop during outstanding database operation"**: old worker's DB work may persist, but the stopped/stale worker does not resolve or commit its Kafka offset.
- Same file, **"invalid second batch event"**: first valid event persists/commits; second invalid event does not silently advance.

These cases were included in the R22 exact-SHA full PG18 suite [#40825279234](https://github.com/omarge/pago-telegraf-waba/actions/runs/40825279234): **420 PASS / 0 FAIL / 1 intentional broker-only SKIP**. This audit does not run them again.

## Architectural limit: two durable transactions

A successfully saved capture candidate without an ingress audit row is **possible** after a crash. It is NOT a confirmed payment or customer receipt. The read-side `businessosR12EconomicReversalHoldProjection.js` requires durable accepted ingress and other source evidence; absent ingress results in HOLD. A repeat of the same original Kafka record is the designed healing path. Do not automatically delete orphan candidates or advance the offset to mask a poison record.

Combining the capture candidate, canonical audit and source binding into a single transaction would require an explicit redesign of `captureInbox.persistCandidate` and `KafkaCommitProcessor.audit` with shared transaction ownership. **Not implemented here**: doing it speculatively could weaken direct-inbox R22 protections, deadlock ordering, event-ID replay idempotence, or interrupt the controlled HOLD journal. Do not claim Kafka/PG exactly-once across two systems.

## Future acceptance tests, only when source integration is authorized

1. Crash before either DB commit; capture candidate absent, no audit row, no Kafka ACK.
2. Crash after candidate commit but before ingress audit commit; candidate present, zero ACK, replay creates audit once.
3. Crash after ingress commit but before Kafka ACK; exactly one candidate, exactly one coordinate ingress row, safe replay + eventual ACK.
4. Competing payload with same event ID at a different offset; no ACK, conflict HOLD.
5. Rebalance / process stop between DB work, heartbeat and commit; old epoch never commits.
6. Concurrent same-tenant same-intent different attempts; R20/R21/R22 source controls prevent ambiguous capture.
7. Independent broker/producer principal and Payment Engine positive economic authority remain separate UAT prerequisites.

## Gatekeeper

No new defect was *established* in the already covered crash/replay cases; no financial source code, DB schema or workflow changes were made in this audit. Reuse R22 existing 420/0/1 evidence. No Actions required for this docs-only branch. Upstream Payment Engine #80/#81 and Payment #13 / Merchant #10, actual secure Kafka UAT and independent PSP reconciliation remain open. WABA remains unmounted candidate/HOLD only.

No `main`/`master`, server, host1, secrets, .env, PSP or Meta interaction; `production_go=NO_GO`.
