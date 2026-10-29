# R21 — Pin the original pre-POST economic identity throughout Kafka and financial projection

**Base** Draft PR #70 / exact certified SHA `49cc4185b6ff188331e279cc39c0d724f8fdb037`. The two fixes originated in independent branches from that same SHA and were integrated here before CI.

## Findings

R20 stored `reserved_businessos_intent_id` and `reserved_businessos_attempt_id` before any Financial POST, with a tenant+reserved intent unique index. However R12 Kafka capture processing and R12 economic read-side projection previously used only the mutable *finalized* `businessos_intent_id` and `businessos_attempt_id`. A post-POST mutation of these fields could permit a capture candidate to appear clean despite conflicting with the original durable reservation.

## Corrective fences

**R21-A:** `businessosR12KafkaCommitProcessor` obtains reserved intent and attempt columns in its existing unique tenant+intent handoff lookup. If either reserved column is present, BOTH must match the capture's canonical tenant-scoped intent/attempt or the processor returns `RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD` with `mayCommit=false`, BEFORE capture candidate storage or Kafka offset ACK. The already established R20 whole-intent handoff uniqueness/attempt match remains first.

**R21-B:** `businessosR12EconomicReversalHoldProjection` also reads the original reserved pair within the same PostgreSQL `REPEATABLE READ READ ONLY` snapshot. If the pair is partial or differs from finalized handoff intent/attempt, return the same specific HOLD. All read-side states remain non-authoritative (`isPaid=false`, `canSendReceipt=false`).

**Legacy compatibility:** a historical row with BOTH reserved identifiers `NULL` remains candidate/HOLD-only compatible; this is explicitly **not** certification of its true PSP identity. Partially populated or contradictory newer rows cannot pass. A future strict migration/backfill must be approved against real authoritative source facts; do not fabricate past economic identity.

## Focused adversarial tests and cost

- Existing R12 Kafka PG18 fake-broker test: mismatched reserved intent, mismatched attempt and one-sided reservation never create a candidate or confirm an offset; an exact reservation may persist **only a candidate**.
- Existing R12 read projection PG18 test: candidate previously appeared clean; mismatched/partial reserved identity returns HOLD; restoring exact reservation returns only `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`.

These are actual financial identity invariants, so the **existing single R12-F+G PostgreSQL18 integrated gate** is justified once on the integrated SHA. No new workflows, no real Kafka, real PSP, host1, .env, main/master or other repository edits.

Payment Engine #80/#81, Payment #13, Merchant #10, authenticated Kafka ACL UAT, and actual reconciled-provider authority remain NO_GO blockers. WABA runtime remains unmounted; no PAID, receipt or WhatsApp payment notification is authorized. `production_go=NO_GO`.
