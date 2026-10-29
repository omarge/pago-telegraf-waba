# WABA R12 ABC — final combined offline certification (NO_GO)

This Draft stacks on PR #44 (A+B), and integrates PR #45 (C) independently by exact Git file copies. PR #44 and #45 stay unmerged and Draft. The source chain remains Draft PR #41 (Kafka offset) → #42 (rebalance A) + sibling #43 (HOLD B) → #44 (A+B) → ABC; PR #45 remains the independent source identity certification.

### Combined controls

A: secure KafkaJS eachBatch shell, `autoCommit=false`, `eachBatchAutoResolve=false`, monotonic offsets, 64-bit successor bounds, stop/rebalance generation fencing with checks after every awaited PostgreSQL boundary.

B: durable no-ACK HOLD journal, no payload/key in clear, immutable digest evidence and allowlisted failure reasons, bounded operator-facing **internal** diagnostics. Not a DLQ, never automatically skip economic unknown or conflicting facts.

C: exact original Payment Engine canonical producer identity for **all owner events**, not only captured. Reject forged noncapture IDs with matching headers; require matching embedded attempt for unknown/resolved and exact status for authorization, failure, unknown and resolution. Production Protobuf schema remains byte-identical and unmodified.

ABC: an invalid economic record is held durably but never acknowledged; a successfully audited safe NON_CAPTURE event may commit its own offset before the later bad record; a stopped/stale partition cannot commit after a DB await. New fixtures encode numeric Protobuf enum values using `fromObject()`, not strings passed to `create()`.

### Verification and limitations

GitHub Actions on the **exact branch HEAD** require full PostgreSQL 18 WABA regression, canonical contract byte hashes and offline static/adversarial checks, in parallel. The Kafka driver is simulated. This is **not** proof of actual SASL/SCRAM authentication, ACL/producer identity, genuine TLS chain, consumer-group multi-node rebalance, quarantine sign-off or Payment economic finality. The Kafka client is not mounted at WABA startup.

**No** `PAID` or receipt release, PSP capture, Meta WhatsApp send, economic retry, host1, .env, secret changes, BusinessOS repo edits, `master/main` merge or deployment. `production_go=NO_GO`.

### Next gates

1. Independent genuine secured Kafka broker certification: principal ACLs, source ownership, TLS, offsets, rebalances and consumer group; separate operator approval.
2. Approved treatment of foreign/unbound captures and poison records without automatic economic skip.
3. Actual Payment reconciliation/finality authority, refund/dispute event processing and CustomerVault/Fraud/Security real integration; Payment Engine release GO.
4. Controlled WABA UAT before any R13 paid receipt or R16 production.
