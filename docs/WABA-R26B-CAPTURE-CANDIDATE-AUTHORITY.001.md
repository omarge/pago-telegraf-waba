# R26-B — Canonical capture inbox authority boundary

Source: WABA R25 exact SHA `1d6169ef6b75f2e164be288ec69bd90c67df026e`, `src/businessosR12CanonicalCaptureInbox.js`.

## Source-backed observation

`persistCandidate` requires enabled mode, verified canonical capture candidate, matching tenant/intent/attempt, amount and payer, and a locked request/handoff/R4 authorization reservation. It checks intent-wide duplicate authorized bindings and appends only a candidate (`STORED_CAPTURE_CANDIDATE_NO_PAID`). Repeated identical event ID is idempotent, conflicting event ID is held. Returns `isPaid:false`, `canSendReceipt:false`, `canSendWhatsApp:false`.

The R20 reservation check intentionally tolerates **both** original `reserved_businessos_intent_id` and `reserved_businessos_attempt_id` being NULL (`legacy` branch). It does not treat the lack of original reservation as an immediate HOLD at candidate insertion. That is an explicit compatibility path, not a proven unauthorized payment or confirmed defect; it requires a documented decision before any production promotion. Mixed NULL/non-NULL identity is denied.

## Release gate

Confirm every downstream reader stays candidate/HOLD for legacy both-NULL records, and no receipt, financial paid state or offset authorization is derived from such records without independent Payment owner evidence. Adversarial test for both-NULL downgrade and subsequent projection contradiction should be added if a source change authorizes progression. PSP settlement finality, Merchant legal entity identity and real TLS/SCRAM/ACL remain external prerequisites; this WABA audit does not access those repos.

No DB, broker, Meta, PSP, secrets, Actions, server or main changes. production_go=NO_GO.
