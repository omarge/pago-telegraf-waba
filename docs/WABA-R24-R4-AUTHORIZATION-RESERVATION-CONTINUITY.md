# R24 A+B — R4 authorization reservation continuity through capture and projection

## Baseline and source evidence

This Draft is stacked on the **R23-A consolidated one-PG18 CI** candidate `ci/waba-r23-single-pg18-gate-20261028`, exact certified SHA `45f436e7766d963ba1fc89ae34e7da0f0c60484e`.

The R11 post-POST finalization (R22) locks and verifies the original R4 `authorization_reservations` (payer and idempotency key) together with request/handoff. But the two independently callable R12 entrypoints `src/businessosR12CanonicalCaptureInbox.js` and `src/businessosR12EconomicReversalHoldProjection.js` previously consulted the later handoff and WABA request, **not the original R4 reservation**. Deleting or replacing that reservation after a recorded authorization could permit a clean `CAPTURE_CANDIDATE_RECONCILIATION_PENDING` diagnostic or a persisted candidate without signaling the broken authorization chain.

## Corrections

**R24-A: direct capture inbox.** Joins the original R4 reservation into its existing PostgreSQL transaction and locks `h,r,ar` using `FOR UPDATE`. Requires the reserved payer to equal the specified account and the R4 idempotency key to equal the durable R11 handoff key. Missing R4 row yields `NOT_ELIGIBLE_HOLD`; altered payer/key yields `AUTHORIZATION_RESERVATION_MISMATCH_HOLD`. Rejects before storing a candidate. This complements existing R20–R22 original pre-POST intent/attempt, tenant and amount checks. It never writes paid status, ledger or a receipt.

**R24-B: read-only financial snapshot.** Uses a `LEFT JOIN` to the R4 reservation inside the existing PostgreSQL `REPEATABLE READ READ ONLY` transaction and compares original payer/idempotency with R11. A deleted, altered or substituted reservation returns `AUTHORIZATION_RESERVATION_MISMATCH_HOLD`, never `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`. Both writes and external effects are prohibited. Exact restored reservation can yield only a **non-final** candidate.

## Adversarial PostgreSQL18 tests

- Direct inbox: changed R4 idempotency key HOLD; substituted payer HOLD; missing reservation HOLD; exact restored reservation persists only a candidate, not PAID or receipt.
- Read-only projector: changed key HOLD; substituted payer HOLD; deleted R4 reservation HOLD; exact restored source stays `CAPTURE_CANDIDATE_RECONCILIATION_PENDING` with all financial-finality flags false.
- Existing R11, R12, R17–R23 regressions must remain GREEN. Do not waive any old fail-closed classification.

## CI cost guardrail

Independent A+B branches from the R23-A certified SHA were integrated **before** CI. The R23-A consolidated `.github/workflows/waba-businessos-r12fg-integration.yml` now owns automatic financial testing: **one** full PostgreSQL18 WABA adversarial suite (`node --test tests/*.test.js`) plus one Kafka factory policy job; the old R11/canonical full-PG18 workflows are no longer automatic for new PRs. No new workflow, Kafka broker or PSP/Meta test is needed.

## Outstanding GO exclusions

The original R4 reservation is still channel-local evidence, not a signed PSP statement or independently authenticated Payment Engine read. The unchanged source-level blockers are Payment Engine [#80](https://github.com/omarge/businessos-payment-engine/issues/80) original-PSP-owner exclusion, [#81](https://github.com/omarge/businessos-payment-engine/issues/81) provider-positive economic finality, Payment [#13](https://github.com/omarge/businessos-payment-engine/issues/13) and Merchant [#10](https://github.com/omarge/businessos-merchant-engine/issues/10) authenticated legal entity identity, and secured real Kafka UAT.

No main/master merge, host1, .env, secrets, real broker, PSP, Meta or cross-repository writes. Modules remain unmounted. `production_go=NO_GO`.
