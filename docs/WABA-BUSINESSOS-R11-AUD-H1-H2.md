# R11-AUD — H1/H2, Fraud-method fencing and financial response identity

**Scope:** Offline, opt-in only, stacked on R11 Draft PR #33. `production_go=NO_GO`. No channel runtime wiring, no live PSP/Meta/Security/Fraud/CustomerVault traffic and no main/master changes.

## RED-first evidence

- First RED attempt on commit `a366a9202ddf75c5a3e62600f034b9c4b81ea557` contained **invalid fixtures**: G/H/J/K are not hexadecimal; this run is NOT relied on as security evidence. Preserved at [initial RED run](https://github.com/omarge/pago-telegraf-waba/actions/runs/40800791116).
- Verified RED-only [Draft PR #35](https://github.com/omarge/pago-telegraf-waba/pull/35), commit `b8d51a4d9fd3fc263beacc9ec49d6e1da11cfd28`, corrects fixtures to AA/AB/AC/AD and runs against the original **unmodified R11**: [PostgreSQL 18 RED run](https://github.com/omarge/pago-telegraf-waba/actions/runs/40801412606), **264 tests, 260 PASS, 4 FAIL, 0 SKIP**.
- Four validated security failures: H1 vault method substitution returned `AUTHORIZED_PENDING_CAPTURE_NOT_PAID` instead of denial, H1 provider/merchant substitution also returned authorization; H2 foreign intent DECLINED was recorded as `DECLINED`; H2 a foreign execution identity on PRE_EXECUTION_FAILED was recorded instead of held.
- Corrected implementation, commit `84c913f16eca8774029e406f9fd1ecc4cc6f0163`: [R11 PostgreSQL GREEN](https://github.com/omarge/pago-telegraf-waba/actions/runs/40801359403) and [R10 integrated regression GREEN](https://github.com/omarge/pago-telegraf-waba/actions/runs/40801359441), **265 tests, 265 PASS, 0 FAIL, 0 SKIP** in each full run; WABA menu and HTTP Happy Path also GREEN.

## Changes

- R10 creates a deterministic SHA-256 commitment using its **trusted** canonical method actually screened by Fraud: request, payer, tenant, customer, merchant, provider account, amount, method provider and opaque reference, approved assessment ID, and device fingerprint/IP.
- R11 recomputes the commitment from the independently resolved server-side Payment authority and the same risk device, refuses any mismatch before PostgreSQL reservation, and snapshots the authority before asynchronous database operations.
- R11 persists this commitment as `authority_fingerprint`; neither bearer nor opaque vault reference is persisted in the handoff. A digest is a local binding, **not** cryptographic attestation of a remote Fraud response.
- Execution-bearing terminal outcomes (`AUTHORIZED_PENDING_CAPTURE`, `DECLINED`) must match the deterministic Payment intent and attempt. Pre-execution outcomes with any returned execution IDs must also match; inconsistent results remain `UNKNOWN_HOLD` and never trigger an automatic retry.
- R11 still cannot capture, emit `PAID`, send receipts, or make a real payment; business authority remains solely with BusinessOS.

## Required next gates

1. Confirm all R10/R11 and historical tests GREEN at the precise final commit, including PostgreSQL 18 and HTTP Happy Path.
2. Resolve H4 (authenticated session, CSRF and consent context attached by trusted route) and H3 (durable signed Meta inbox before HTTP 200), without enabling financial dispatch.
3. Inspect actual Payment outcome/reconciliation contracts in BusinessOS (read-only) before implementing R12 economic finalization. Never invent an API.
4. Multi-process/failover tests and UAT integration remain pending. `production_go=NO_GO`.
