# R20 A+B — Pre-POST economic identity reservation and Kafka source ambiguity fencing

**Baseline:** Draft R19 PR #69, certified exact head `ce36f68419d5b6bf8b1f91fc2e475d404147cad7`. Independent R20-A (R11 reservation) and R20-B (R12 Kafka capture) worktrees were created from the same baseline and merged before requesting CI.

## Confirmed code facts

`src/businessosAuthorizationAdapter.js` generates a deterministic `paymentIntentId`, `paymentAttemptId` and idempotency key from `SHA-256("waba-businessos-auth-v1\\n" + trusted tenant + "\\n" + WABA request_id)`. Under normal, untampered inputs, different request IDs do **not** share an intended economic identity. However, the R11 PostgreSQL schema previously had unique `request_id` / `idempotency_key` only; the final source-level association to a BusinessOS PaymentIntent was not independently reserved as a unique DB fact **before financial POST**. R19 only diagnosed duplicates later, in a read-side projection.

### R20-A — uniqueness at reservation, BEFORE any adapter call

`db/waba-r11-channel.sql`: add `reserved_businessos_intent_id` and `reserved_businessos_attempt_id` text columns to the isolated WABA-channel handoff table and an explicit **unique partial index** on `(tenant_id,reserved_businessos_intent_id)` when reserved intent is not null. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` supports old WABA test-channel schemas. The index includes `UNKNOWN_HOLD` reservations, which can already represent a real external PSP attempt; it is not dropped just because a response is indeterminate.

`src/businessosR11FencedAuthorization.js`: write both **preflight** trusted intent/attempt identifiers in the same transaction as the pre-POST authorization reservation. A conflicting tenant+intent unique index aborts that transaction, rolls back **both** reservation and handoff and returns sanitized `DB_UNAVAILABLE_NO_EFFECT`; **zero** financial adapter invocations. The subsequent finalization UPDATE requires the stored reserved identifiers to equal those originally used for the POST, preventing a request's expected economic identity from silently changing between reserve and update. No retry or fallback.

**Compatibility limit:** historical R11 handoffs with null reserved identifiers remain null. This schema does NOT retroactively attest or reconstruct their past execution identities; old ambiguous evidence stays HOLD under R19. Operator review is required before any release; do not backfill from arbitrary or client-supplied data. This isolated draft is not applied to live UAT.

### R20-B — one economic intent before capture Kafka ACK

`src/businessosR12KafkaCommitProcessor.js`: capture lookup now matches authorized `tenant_id+businessos_intent_id` **without filtering away different attempts**, `LIMIT 2`, and only proceeds if exactly one row exists AND that row's `businessos_attempt_id` equals the wire candidate. Thus two handoffs with the same PaymentIntent but different attempts cannot produce a durable candidate or advance a Kafka offset. Cross-tenant handoffs do not collide. This supplements, rather than replaces, R19 read-side HOLD.

## PostgreSQL18 adversarial evidence required

- R20-A: a prior handoff occupies the deterministic tenant+intent expected by a second request. The attempted second authorization must fail before the external adapter, leave no orphan reservation/handoff, and keep the first record. A timeout after one authorized POST leaves reserved IDs in an `UNKNOWN_HOLD` row and never retries.
- R20-B: two authorized handoffs with same tenant+intent but different attempts, one valid captured wire, must be held with zero Kafka offset commits and zero candidate rows. The same intent in a different tenant is a legitimate independent control, not a false collision.
- R11/R12/R17/R18/R19 previous crash/replay/UNKNOWN/idempotency tests must remain GREEN.

## CI budget & operating constraints

Because this alters **pre-POST economic idempotency authority** and **Kafka offset-admission policy**, run exactly ONE existing R12 F+G PostgreSQL18 consolidated regression on the final integrated SHA, after combining both branches. Do not add workflows, rerun Kafka real or launch Payment Engine/Security suites.

WABA remains **unmounted OFFLINE**. Payment Engine #80/#81, Payment #13 and Merchant #10 source-level authority/merchant-identity P0 issues, real secured Kafka UAT, and actual independent PSP reconciliation are still blocked. No `PAID`, receipt, Meta send, PSP calls, deployment, host1, .env, secret, other repository write, main/master merge. **production_go=NO_GO**.
