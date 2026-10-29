# R22 — Close POST-response authority TOCTOU and direct capture inbox bypass

**Certified base:** Draft PR #71 exact SHA `857b6058a6c50b3493947b0099acf5901bf23b67`. R22-A and R22-B were implemented on independent branches from that SHA and combined before CI.

## R22-A — direct capture inbox must independently check original reservation

Previously R21 enforced the original `reserved_businessos_intent_id` and `reserved_businessos_attempt_id` in the Kafka commit processor and financial projector. The separately callable `businessosR12CanonicalCaptureInbox.persistCandidate` only matched `businessos_intent_id`/`businessos_attempt_id` (finalized mappings), so a direct caller could store a candidate after the original economic reservation was changed. It also did not independently reject two authorized WABA handoffs with the same tenant+intent.

**Fix:** under the existing `SELECT ... FOR UPDATE OF h,r` transaction, compare non-legacy original reserved intent+attempt with the verified captured source. One-sided or mismatched reservation returns `RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD`. Independently query authorized handoffs on the **full tenant+intent** boundary (`LIMIT 2`), require exactly one and original request ID, otherwise `AMBIGUOUS_PAYMENT_INTENT_BINDING_HOLD`. Neither case writes any capture candidate. Historical rows with BOTH reserve fields NULL remain candidate-only, **not** financial-finality evidence. The canonical inbox is not a payment or Meta dispatcher.

New adversarial PG18 cases: original reserved intent, reserved attempt and partial pair tampering block direct inbox; repaired exact original allows only a candidate; second same-tenant authorized request sharing intent blocks direct inbox; foreign-tenant handoff is isolated.

## R22-B — response finalization revalidates the original consent/Fraud/payer/request commitment

Previously R11 stored a protected original pre-POST reservation and validated the response's payment IDs, but the post-provider `UPDATE` only pinned request ID, UNKNOWN outcome and reserved IDs. If a request amount, Fraud fingerprint, handoff tenant/customer/assessment/payer, or R4 reservation had been mutated **while the external POST was in flight**, a positive response might still be recorded as if its original authorization context remained unchanged.

**Fix:** within the existing post-response transaction, `SELECT` with `FOR UPDATE OF h,r,ar` locks handoff, original request and R4 authorization reservation; compare immutable request snapshot, payer, consent-bound amount/currency/state/creation timestamp, tenant, customer, Fraud assessment and method binding fingerprint, idempotency key, and original reserved economic identity. Any missing, partial or contradictory evidence returns `HOLD_NO_AUTO_RETRY` and the public result remains `UNKNOWN_HOLD_NO_AUTO_RETRY`. The adapter has already been invoked; there is **no** automatic retry or fallback and no fictitious rollback of the PSP effect.

New adversarial PG18 cases mutate the Fraud binding fingerprint, the WABA request amount, or the R4 idempotency reservation while a fake authorized Payment response is pending. All must remain UNKNOWN and never finalize.

## Certification cost and release boundaries

The code alters two actual financial source-of-truth gates: R11 post-POST authorization finalization and R12 direct candidate persistence. Existing R11 and R12-F+G PostgreSQL18 workflows may trigger once on the integrated SHA. Do **not** create workflows, run Kafka real, repeat Payment Engine/Security suites, or deploy.

R11 external Payment API remains injected/offline; R12 inbox remains an unmounted candidate store. These fixes do not atomically combine independent Kafka audit and candidate persistence into one transaction; an interrupted flow can retain a candidate with no acknowledged Kafka offset and must still replay/fence. All successful states remain **not PAID, not provider-reconciled, no receipt, no WhatsApp payment confirmation**. Payment Engine #80/#81, Payment #13 and Merchant #10, plus authenticated Kafka UAT and independent PSP evidence remain release blockers. No changes to main/master, host1, .env, secrets, other repos, actual PSP or Meta.
**production_go=NO_GO**.
