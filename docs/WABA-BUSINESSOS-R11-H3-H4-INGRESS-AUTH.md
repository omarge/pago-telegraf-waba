# WABA / BusinessOS — R11 H3/H4 offline certification and rollout gates

## Scope and safety

Draft PR #36, stacked on PR #34. Offline code path only. No deployment, main/master changes, Meta sends, Payment dispatch, real Fraud/CustomerVault/Security calls or PSP charge. `production_go=NO_GO`.

### H3 — signed durable webhook

The R5 PostgreSQL AES-256-GCM signed inbox is now available from the actual WABA startup, but is **explicitly opt-in**. The pilot default preserves its original signed, non-durable, acknowledge-before-handler mode; it remains **NOT UAT-certified**.

A strict rollout requires configuration names (never copy real values into files):
- `WABA_BUSINESSOS_DURABLE_WEBHOOK=1`
- `WABA_CHANNEL_PG_URL` — PostgreSQL connection URI for the isolated channel schema
- `WABA_INBOX_AES256_KEY_HEX` — 32-byte AES key encoded as 64 hex characters
- `WABA_APP_SECRET` — Meta App Secret for HMAC; not WABA_VERIFY_TOKEN or WABA_TOKEN

The database must already have schema `waba_channel`, tables `signed_envelopes` and `inbox`. **No migration is applied during startup**. Invalid flag, missing secrets, disconnected DB or missing schema prevent a strict webhook listener from opening. Strict mode refuses `WABA_SAVED_CARD_PAY_SANDBOX=1` so direct PSP payment and channel-only BusinessOS routing are not mixed.

The HTTP route verifies original Meta bytes, parses the envelope, encrypts and commits both envelope and inbox events; only `STORED` or `DUPLICATE` returns HTTP 200. Signature violation is 403, invalid content 400, envelope collision 409, database unavailability 503. No automatic replay or financial execution.

**Operational limitation:** strict mode stores inbound messages but intentionally does **not** invoke the legacy bot handler. The R6/R7/R8 authorized inbox/routing/notification workers are not yet wired to production. Turning on strict mode without those workers would interrupt normal reply processing. No UAT or production activation is authorized.

### H4 — authenticated R11 payer boundary

The optional `businessosFencedAuthorization` + `businessosFencedRequestStore` dependencies mount a separate `/pay/app/businessos/r11/authorize/:requestId` GET/POST route behind `accountRoutes.requireSession`. The browser is not allowed to provide account, tenant, Fraud result, payment method, PSP reference or bearer authority. The server checks the session's account, asynchronously reads the payer-bound request, validates CSRF with the current session token and explicit consent, and invokes only injected `authorizeOnce({requestId,accountId,csrfVerified:true,consent:true})`.

This opt-in mount is mutually exclusive with the legacy saved-card direct PSP path or older non-durable R2 authorization flow. It returns `AUTHORIZED_PENDING_CAPTURE_NOT_PAID` as pending; HOLD and UNKNOWN forbid replay or 'Pago completado' notifications.

**Operational limitation:** R11 isn't wired to an actual Payment Engine adapter at startup, and current in-memory web sessions aren't horizontally durable. Real CustomerVault, Fraud, delegated Security authority, and production payer identity still require end-to-end certification.

### Remaining gates

1. Confirm the exact head SHA and all H3/H4, R2–R5/F06/F09, R10/R11 regressions GREEN.
2. Wire R6 signed inbox normalization and R7/R8 safe outbox to strict ingress with authorized workers. No event may produce economic side effects without Security Engine.
3. Certify durable session/identity across multiple instances, expiry and CSRF rotation; verify POST with genuine R11 PostgreSQL fence.
4. R12: audit true BusinessOS Payment economic-finality and reconciliation contracts read-only before any implementation.
5. Full UAT, capture confirmation and production remain `NO_GO`. Only the user can authorize merge/deploy.
