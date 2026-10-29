# R27-B — RED-first compatibility audit (NO SOURCE CHANGE)

Baseline R25: `1d6169ef6b75f2e164be288ec69bd90c67df026e`.

## Finding
The read-only projection explicitly allows both original pre-POST reserved economic IDs NULL (legacy). It may classify a matched capture as `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`, which is **never** PAID, reconciled, provider-verified or receipt-authorized. A strict HOLD could clarify missing provenance, but any changed classification must be accompanied by isolated real PG18 tests and cross-version compatibility analysis.

## RED-first test compatibility discovery
The existing `tests/businessos-r12-economic-reversal-hold.test.js` helper `setup()` inserts historical authorization handoffs **without** populating `reserved_businessos_intent_id` or `reserved_businessos_attempt_id`. Numerous existing tests explicitly expect `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`. A naive unconditional strict legacy HOLD would invalidate those historical fixtures and fail the financial regression. A candidate one-file change was therefore **reverted on this isolated branch** before any claim of GREEN. Final runtime source is byte-identical to R25.

## Next implementation requirements
1. Separate true historical both-NULL records from new reservations in test fixtures. Verify migration defaults and backfill semantics; never pretend missing historical authority is present.
2. Add PG18 adversarial cases proving legacy both-NULL remains non-final (and any new strict mode produces an explicit HOLD) plus partial-NULL mismatch and matched fully reserved source.
3. Approve desired migration policy (diagnostic legacy candidate vs strict HOLD). Only then alter reader/inbox and execute one R12 F+G integrated PG18 gate.
4. Keep actual Payment PSP authority, Merchant identity and Kafka TLS/SCRAM/ACL outside the WABA repo; do not access other repositories.

No paid effects, no Actions requested, no main, host, secrets or deployment. production_go=NO_GO.
