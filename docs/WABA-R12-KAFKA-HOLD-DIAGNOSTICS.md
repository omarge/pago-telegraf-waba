# R12 — Held-record incident journal and diagnostics (OFFLINE ONLY)

Stacked Draft on PR #41, independent of the rebalance workstream; `production_go=NO_GO`.

A Kafka record rejected by the offline Payment canonical processor **must remain unacknowledged**. The new `createR12KafkaHoldJournal` records only exact source topic, partition and offset, SHA-256 of payload and key, a bounded allowlisted reason, observation count and timestamps. It never stores payload, headers, bearer, PAN, phone, customer or raw key. Held evidence is immutable per coordinate: changed payload, key or reason returns `HOLD_EVIDENCE_COLLISION` without overwriting first truth. Repeated identical observations increment the counter. A bounded read-only diagnostic listing exposes only sanitized coordinates/reason/age, not secrets.

`createR12HeldRecordProcessor` is a composable **offline optional** wrapper: it delegates to existing processing and, for rejected decisions, attempts to persist the HOLD reason while preserving `mayCommit=false` regardless of DB outcome. It does **not** call `commitOffsets`, skip, seek, publish DLQ, resend payments or send WhatsApp; unexpected processor errors remain unacknowledged. It is not injected into the WABA runtime or Kafka consumer automatically.

PostgreSQL 18 tests cover default dark mode, invalid reason, oversized/malformed inputs, source collisions, duplicate observations, concurrent writers, database outage, redacted listing and no-ack wrapper behavior, plus full prior WABA regression.

**Not certified:** authorized operational resolution, production correlation of unknown captures, quorum/owner rights, replay procedures, real Kafka poison-topic routing, SLAs, broker ACL and actual UAT. Manual review is the only path out of a HOLD. No `PAID`, no R13 receipt, no changes to other repos, `main/master`, hosts or `.env`.
