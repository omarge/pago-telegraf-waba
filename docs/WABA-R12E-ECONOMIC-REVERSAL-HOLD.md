# R12-E: Read-only economic contradiction and reversal HOLD (offline)

This independent Draft branch starts from PR #46 exact SHA `1f763385f1cc1610e927af4cc70a5648bca6d918`. It modifies **only** the WABA repo and never enables payment, `PAID`, a receipt, Meta notification, Kafka consumer or PSP effect.

`createR12EconomicReversalHoldProjection({enabled:false,pool}).assess({requestId,accountId})` performs a PostgreSQL REPEATABLE READ, READ ONLY snapshot, joins the original durable R11 payer/tenant/intent/attempt and amount/currency, reads *all attempts for the same tenant+PaymentIntent* in R12 canonical ingress and the WABA capture candidate(s), and classifies:

- No exact authorized handoff, missing/mismatched amount, missing candidate or orphan capture: HOLD.
- Any `PaymentRefunded`, `PaymentExecutionUnknown`, `PaymentExecutionResolved` or `PaymentFailed` in the intent scope: HOLD, even if a matching capture candidate exists. It cannot infer provider finality from a resolved status alone.
- Same business event ID with differing SHA or identity, mixed disposition or cross-attempt ambiguity: HOLD.
- Exactly one original matching capture candidate and signed matching captured evidence, with no known contradicting event: **`CAPTURE_CANDIDATE_RECONCILIATION_PENDING`** — still `isPaid=false`, `isFinal=false`, `isReconciled=false`, `canSendReceipt=false`, `canSendWhatsApp=false`.

This is a **conservative local observation**, not a genuine authoritative reconciliation read from BusinessOS; a missing refund/outbox event at snapshot time is NOT proof that a refund does not exist. The snapshot can become stale as soon as it ends, so it never authorizes notification. No direct HTTP or Kafka source identity is inferred.

Real PostgreSQL 18 adversarial tests cover cross-payer, unknown handoff, reversed ordering, same-intent different attempt, amount mismatch, absent source evidence, event ID collision, DB error and candidate-only semantics. `production_go=NO_GO`. Real Payment Engine reconciliation authority, provider capture evidence and signed external transport remain future gates.
