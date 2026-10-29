# R17 A+B — Actual capture-evidence integrity fix (not another self-report validator)

## Exact source and baseline

This change is stacked on certified **WABA R16 Draft PR #66**, SHA `020a27d93ccb92d5461b1d600fa8f17c44062478`. The two independent correction branches were built against that same base and combined into **one** candidate for GitHub certification, avoiding duplicate costly regression runs.

The affected module is the **existing** `src/businessosR12EconomicReversalHoldProjection.js`, an optional **unmounted** `REPEATABLE READ READ ONLY` PostgreSQL 18 projection. It never authorizes `PAID`, reconciles provider state, sends a receipt or makes a Kafka/PSP/Meta call. The canonical `PaymentCaptured` event by itself is still only a candidate and all source Payment/Merchant P0 GO conditions remain blocked.

## Two demonstrated gaps and exact fixes

### R17-A: competing captures across attempts for one payment intent

Prior to this patch, the projection queried all canonical ingress events for `tenant_id + payment_intent_id` but only explicitly treated refund, UNKNOWN, resolved and failed as adverse. Two distinct valid `PaymentCaptured` events on different attempts could leave the original one labeled `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`. That overlooks a potential multiple-charge/capture collision and makes the visible capture evidence appear less contradictory than it is.

**Fix:** after verifying event-ID payload/hash consistency, inspect every `PaymentCaptured` ingress record in that same tenant+intent scope. If a capture is tied to any **other attempt**, or more than one distinct `PaymentCaptured` event ID is observed, return `COMPETING_CAPTURE_ATTEMPTS_HOLD`. Exact `event_id + payload_sha256` duplicates at different Kafka offsets are allowed: Kafka redelivery is not a second economic fact. The existing payload/event collision HOLD remains higher priority.

### R17-B: candidate identity not fully rebound to the authorized handoff

The existing candidate query selected `event_id, payload_sha256, payment_attempt_id, amount_cents, currency` but omitted the candidate row's own `tenant_id` and `payment_intent_id`. If those persisted columns had been corrupted, the projection could still show the candidate as matching because the canonical ingress was correctly scoped but the candidate record itself was not checked for its source tenant/intent.

**Fix:** explicitly read both columns from `canonical_capture_candidates` and require them to equal the R11 handoff's authorized `tenant_id` and `businessos_intent_id`. A mismatch returns `CAPTURE_EVIDENCE_MISMATCH_HOLD` with no financial effect.

## Independent PostgreSQL18 adversarial tests

Three additions to `tests/businessos-r12-economic-reversal-hold.test.js`:
1. Original capture candidate plus a second `PaymentCaptured` from another attempt → `COMPETING_CAPTURE_ATTEMPTS_HOLD`.
2. Same canonical captured event and digest replayed at a new Kafka offset → `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`, still `isPaid=false`.
3. Candidate tenant mismatch, then candidate payment-intent mismatch, against the same R11 handoff → `CAPTURE_EVIDENCE_MISMATCH_HOLD`.

All existing refund/UNKNOWN/reversal/poison HOLD tests must remain unchanged and pass.

## Cost and certification policy

A change to actual economic classification justifies **one exact-SHA PostgreSQL18 regression** (existing R12 F+G financial gate), rather than pretending a pure offline test proves SQL behavior. Do **not** start extra real Kafka broker jobs or repeat other financial engine suites. If the existing R12 F+G gate fails, diagnose the exact failing PostgreSQL test and apply the smallest fix; preserve RED evidence.

## Release blockers unchanged

A real authenticated, tenant-scoped Payment Engine read model and verified PSP owner exclusion #80 / provider economic finality #81 are absent from this WABA branch. Payment #13 and Merchant #10 also remain external identity-contract blockers. No HTTP endpoint is fabricated. No `main`/`master`, hosts, secrets, `.env`, external repository writes or real PSP/Meta operations. **`production_go=NO_GO`**.
