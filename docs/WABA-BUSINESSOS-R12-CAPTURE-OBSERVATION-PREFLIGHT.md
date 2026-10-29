# BusinessOS WABA R12 — Economic capture observation preflight (OFFLINE)

## Authority boundary

This PR introduces a **WABA-local capture-observation candidate checker**, not a BusinessOS capture endpoint and not an economic-completion adapter. It must remain disabled by default. There is no Meta sender, PSP write, receipt, journal, `PAID`, remote Payment execution or production wiring.

### Contracts verified read-only in the private Payment Engine repository

- `payment-engine-app/src/main/java/com/businessos/payment/app/authorization/adapter/rest/PaymentAuthorizationController.java`: conditional `POST /internal/v1/payment-authorizations` only; its `AUTHORIZED` result is **authorization**, not proof of captured funds.
- `payment-domain/src/main/java/com/businessos/payment/domain/model/PaymentIntentStatus.java`: `AUTHORIZED`, `PARTIALLY_CAPTURED`, `CAPTURED`, `SUCCEEDED` are distinct, and `isSuccessLike()` accepts only `CAPTURED` or `SUCCEEDED`.
- `payment-domain/src/main/java/com/businessos/payment/domain/model/PaymentAttemptStatus.java`: `UNKNOWN`, `AUTHORIZED`, `CAPTURED`, `SUCCEEDED` are distinct.
- `payment-domain/src/main/java/com/businessos/payment/domain/model/ProviderOutcomeStatus.java`: distinguishes `AUTHORIZED`, `CAPTURED`, `SUCCEEDED`, `UNKNOWN`.
- `payment-domain/src/main/java/com/businessos/payment/domain/model/ReconciliationFindingType.java`: `MATCHED`, `AMOUNT_MISMATCH`, `LOCAL_CAPTURED_PROVIDER_NOT_CAPTURED`, `LOCAL_FAILED_PROVIDER_CAPTURED`, `EVIDENCE_TEMPORARILY_UNAVAILABLE` and others. A historical local CAPTURED without authoritative corroboration cannot automatically release a receipt.
- The WABA R11 channel table `db/waba-r11-channel.sql` stores payer, tenant, amount, currency, original Payment intent/attempt identifiers, and outcome `AUTHORIZED_PENDING_CAPTURE`, still with no authority to mark a payment PAID.

**Critical distinction:** no currently verified trusted WABA-consumable REST/read/event capture-finality contract has been found. Existing Payment domain enum names and repository commit history establish **domain semantics**, not an authenticated notification or source query. Do not invent such a route.

## Implementation

`src/businessosR12CaptureObservationGate.js` provides `createR12CaptureObservationGate({enabled:false,pool,readAuthoritativeObservation})`. The injected reader is **not an implementation of a real Payment API** and its arguments and returned normalized object are **a WABA-local, not-upstream-contract** intended solely for offline tests and future integration design.

`probe({requestId,accountId})`:
1. Validates the caller-provided request selector and account ID, then reads the existing durable R11 authorization handoff joined to the request; checks exact payer, tenant, PENDING, MXN, positive safe integer amount, intent+attempt IDs and `AUTHORIZED_PENDING_CAPTURE`. `UNKNOWN_HOLD` is never eligible.
2. Passes only a snapshot already persisted in PostgreSQL to an injected source reader. No browser-supplied economic status, Fraud verdict or service bearer is accepted.
3. Compares tenant, intent, attempt, amount and currency; requires the real Payment domain SUCCESS-like statuses for intent and attempt, SUCCESS-like provider outcome and `MATCHED` reconciliation. Anything incomplete, partial, unknown, mismatched or contradictory returns HOLD.
4. Re-reads the durable handoff after the awaited observation to reject races where the payer, amount, or authorization record changed. No local economic status mutation is performed.
5. Even when every *local candidate* criterion matches, returns **`CAPTURE_EVIDENCE_CANDIDATE_OFFLINE_ONLY`** with `isPaid=false`, `isCaptureCertified=false`, `canSendReceipt=false` and `canSendWhatsApp=false`. This is NOT release authority.

## Gatekeeper and remaining gaps

Before unlocking any R12 financial confirmation or R13 notifications:
- Discover and independently certify an **actual** Payment Engine API/event/read model for captured, success, refund/dispute and reconciliation state, including replay/ordering/versioning and economic idempotency.
- Authenticate its transport, verify tenant and principal scope, source IDs, amount/currency, event sequencing, provider evidence and conflicting reconciliation.
- Confirm behavior for partial captures, refunds, disputes, late UNKNOWN, missing provider evidence, duplicate events, inconsistent provider IDs and multiple PSP accounts.
- Certify the production Payment Engine GO; at this time Payment Engine release remains NO_GO.
- Add a separate reviewed durable inbox/outbox for finality and notifications only after genuine source authority; no direct PSP path or historical WABA automatic PAID announcements are permitted.

**Scope**: Draft PR stacked on #38. Only WABA repository modified; no hosts, .env, paid calls, Meta messages, or BusinessOS code changes. `production_go=NO_GO`.
