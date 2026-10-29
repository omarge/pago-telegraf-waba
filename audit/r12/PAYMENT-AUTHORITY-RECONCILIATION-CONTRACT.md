# R12-I — Authoritative Payment reconciliation contract required before R13 receipts

## Verified facts from repositories

The inspected upstream Payment Engine files (`omarge/businessos-payment-engine/master`) implement **durable owner-event outbox publishing** (`SpringCanonicalPaymentEventEmitter`, `PaymentCanonicalEventOutbox`, `PaymentCanonicalEventRelay`). They emit `PaymentAuthorized`, `PaymentCaptured`, `PaymentExecutionUnknown`, `PaymentExecutionResolved`, `PaymentFailed`, and `PaymentRefunded` as Kafka Protobuf, with payment attempt and tenant metadata.

The WABA read-only `src/businessosR12EconomicReversalHoldProjection.js` checks **locally observed events only**; it returns `CAPTURE_CANDIDATE_RECONCILIATION_PENDING`, never PAID, for a clean candidate. Its additional R12-G check consults locally held Kafka records by SHA256(`tenant|paymentIntentId`). **Absence of records or HOLD is not proof that the Payment Engine has finished publishing or that PSP settlement succeeded**.

The inspected upstream files **do not establish a supported authenticated WABA-readable Payment finality endpoint**. This does NOT prove no endpoint exists elsewhere; an owner-approved actual interface must be identified and validated before integration. **No endpoint has been invented or called.**

## Proposed minimum authority read contract — NOT an existing API

A future, authenticated source-owned read model must prove:
- Tenant, payment intent, attempt and WABA request association, immutable cents/currency and customer binding.
- Actual PSP economic capture/finality evidence, source and timestamp, trace/correlation and collision-resistant evidence SHA.
- Reconciliation verdict with trace to the real PSP/provider, refund/dispute/chargeback and UNKNOWN/resolved authority.
- Source completeness watermark (high-watermark, outbox/inbox lag) and bounded freshness so a missing/late event is never mistaken for no reversal.
- Distinct principal/permissions, TLS trust, object-level tenant authorization, revocation, anti-replay and independent UAT.
- Consistency across concurrent retries, recovery and delayed refunds, preferably versioned snapshots with monotonic watermark.
- A final **independent Gatekeeper decision** before any user notification. Authorization is never capture; capture event is never final PSP settlement proof by itself.

The new `audit/r12/reconciliation-authority-preflight.js` is a **non-runtime proposal**. It validates prerequisite *shapes*, denies missing/mismatched data, rejects unknown/contradictory states, and even for all self-reported PASS fields returns `INDEPENDENT_PAYMENT_AUTHORITY_INTEGRATION_REQUIRED_HOLD`. It always sets `isPaid=false`, `canSendReceipt=false`, `realEndpointIntegrated=false`, `productionGo=false`.

No changes to real money, Kafka consumption, Payment Engine, secrets, host1, GitHub master/main, deployed WABA, or production go flags. This is a static contract/audit contribution only. `production_go=NO_GO`.
