# R19 A+B — Prevent ambiguous payment-intent bindings and cross-scope canonical ID reuse

**Base:** R18 Draft PR #68, certified exact SHA `9f38b253a38024e9f9cd31cf7f9b2bd07c5ab24d`. Two independent source and test branches were prepared from that SHA and integrated into this one candidate. No changes to live startup, financial commands, PostgreSQL schema or external repositories.

## Real source-based findings

### R19-A — Multiple WABA requests may share a BusinessOS PaymentIntent

The real R11 schema `db/waba-r11-channel.sql` has one primary key on `request_id` and a unique `idempotency_key`, **not** a unique key on authorized `tenant_id + businessos_intent_id`. `src/businessosR12KafkaCommitProcessor.js` already refuses a canonical capture when its lookup of the same authorized tenant+intent+attempt is ambiguous (`LIMIT 2`). However `src/businessosR12EconomicReversalHoldProjection.js` previously read the requested handoff only, so a **second authorized request for the same tenant+intent** could appear later while the first retained `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`.

**Correction:** in the same `REPEATABLE READ READ ONLY` snapshot, query `payment_authorization_handoffs` for at most two `AUTHORIZED_PENDING_CAPTURE` rows sharing the tenant+intent. Require exactly one and require that the row's `request_id` matches the caller's authorized request; otherwise `AMBIGUOUS_PAYMENT_INTENT_BINDING_HOLD` with no receipt. Cross-tenant rows do not affect the authorized tenant.

This is a **read-side diagnostic defense, not a uniqueness enforcement of concurrent writes**. Actual one-to-one source ownership should be defined upstream or with a separate independently reviewed unique constraint, not silently introduced to a deployed DB.

### R19-B — Global canonical event ID reused outside the local economic scope

Kafka `event_id` identifies the canonical business fact, not a per-tenant/per-offset delivery. The Kafka durable ingress audit added R18 safeguards for new records. Yet the read-side R12-E projection scanned only its own tenant+intent. If historical/untrusted ingress contains the same canonical capture event ID for another intent or tenant, a matched local capture could still be presented as `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`.

**Correction:** on a single captured candidate, query the globally indexed `canonical_kafka_ingress.event_id` for any row with different tenant, intent or attempt (bounded `LIMIT 1`). If present, return `CROSS_SCOPE_EVENT_ID_REUSE_HOLD`. No raw IDs or payment data are exposed. An exact legitimate replay on another offset **within the same economic identity** remains permitted.

## Required proof on exact final SHA

Two new PostgreSQL18 cases in `tests/businessos-r12-economic-reversal-hold.test.js`:
1. R19-A: existing capture clean, foreign tenant duplicate ignored, same-tenant second authorized request bound to same intent triggers HOLD.
2. R19-B: existing capture clean, duplicate event ID with a foreign intent triggers HOLD, then foreign tenant triggers HOLD.

Use **one** existing R12 F+G integrated PostgreSQL18 regression because the economic evidence classification changed. Retain historical Kafka/projection tests and all previous NO-PAID outcomes. No new workflow, no real broker, no Payment Engine/Meta/PSP calls.

## Gatekeeper boundaries

`isPaid=false`, `canSendReceipt=false`, `canSendWhatsApp=false` in all branches. WABA remains an offline, unmounted candidate/diagnostic adapter. Payment Engine P0 [#80](https://github.com/omarge/businessos-payment-engine/issues/80), [#81](https://github.com/omarge/businessos-payment-engine/issues/81), Payment [#13](https://github.com/omarge/businessos-payment-engine/issues/13), and Merchant Engine [#10](https://github.com/omarge/businessos-merchant-engine/issues/10) remain external source owner and identity blockers. Real TLS/SCRAM Kafka UAT remains untested. No merge, `main`/`master`, host, `.env`, secrets, other repo mutations, live economic or messaging effects. **production_go=NO_GO**.
