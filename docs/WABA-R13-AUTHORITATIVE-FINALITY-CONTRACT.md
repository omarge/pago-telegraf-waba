# R13 authoritative payment reconciliation contract — information boundary

Read-only audit of real `omarge/businessos-payment-engine/master`: `SpringCanonicalPaymentEventEmitter` writes canonical captured/unknown/resolved events into durable outbox within the authoritative transaction. `PaymentCanonicalEventRelay` can relay them on Kafka. **Neither this nor the WABA candidate inbox establishes a certified WABA-readable provider reconciliation API**. Do NOT invent an endpoint, fake MATCHED result, or declare payment final.

This branch provides a *pure shape-review contract* for future authenticated evidence: tenant/intent/attempt, provider transaction, amount in exact cents/currency, claimed captured status, reconciliation ID/status, source revision, provider proof verification, authenticated source, no unresolved refund/UNKNOWN. Missing/contradictory fields yield `MISSING_AUTHORITY_HOLD`. Even a fully populated user-supplied claim yields `CLAIM_SHAPE_ONLY_NO_FINALITY` and always `isPaid=false`, `canSendReceipt=false`; only a future real upstream authority plus independent verification could change that policy in a separate certified release.

**Source gaps:** discover and verify the Payment Engine authoritative capture/reconciliation read model, authorization and tenant scoping, signed business revision/order, economic amount/attempt mapping, refund/dispute/unknown post-capture completion, as-of freshness, failure semantics, audit log, and provider PSP evidence. No source API discovered or asserted here.

**Cost:** no new Actions workflow; three narrowly scoped Node tests, no database/PSP/Meta network. No main/master, host1, secrets or other repository writes; production NO_GO.
