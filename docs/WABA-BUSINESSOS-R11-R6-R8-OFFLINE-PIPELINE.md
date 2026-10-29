# WABA → BusinessOS R11 — Durable inbound pipeline R5/R6/R7/R8 (OFFLINE)

## Scope
Draft PR #37 stacked on #36. The channel remains `production_go=NO_GO`. No merge/deploy, .env or live Meta/PSP/CustomerVault/Fraud/Security Engine activity. Existing customer microapplications are untouched.

## Verified processing boundary
1. The F09/R5 ingress previously authenticates the original Meta bytes, encrypts them and commits `waba_channel.signed_envelopes` and `inbox` before ACK. Strict H3 mode is opt-in, not deployed.
2. An explicitly enabled **manual, offline** call `createR11OfflineInboundPipeline({pool,encryptionKey,enabled:true}).stageEnvelope({envelopeDigest})` runs the existing R6 transactional normalization on that exact envelope.
3. R7 classification is bounded by the same trusted `sourceEnvelopeDigest`, and stages committed routing facts. The legacy unscoped R7 public method shape is preserved.
4. R8 prepares **only** `MENU_CANDIDATE` intents as `safe_menu_outbox.READY`. It uses exactly the metadata already authenticated in the signed envelope and routing facts. No send callback is offered by the pipeline, and R8 dispatcher is hard-disabled.
5. Financial-looking commands remain `AWAITING_SECURITY_ENGINE`; delivery statuses and unsupported messages never become menu sends. `AUTHORIZED` never means `PAID`.
6. On a crash after R7 commit but before R8 insertion, a later call with the same envelope digest reads the committed routes and fills missing safe menu intents, without normalizing/re-routing duplicates. A bounded limit of 100 routes and menu candidates per invocation yields `PARTIAL_OFFLINE_NO_DISPATCH` until subsequent invocations complete it.

## Safety, failure and operational limits
- **No automatic worker or scheduler is installed at startup.** A trusted offline harness must choose an existing `signed_envelopes.envelope_digest`; no public route or source-body input is exposed.
- PostgreSQL `FOR UPDATE SKIP LOCKED`, unique keys and an outbox NOT EXISTS cursor provide idempotent staging across processes. Failure can leave a partially staged *non-economic* batch, recoverable by repeating the same digest.
- Corrupted GCM tags or digest and R5 fact mismatches quarantine events before command classification. DB faults produce sanitized `RETRYABLE_NO_EFFECT`; no plaintext, keys or bearer values are logged.
- The pipeline has `hasExternalEffects:false`, `isFinancialDispatcher:false`, `isMetaDispatcher:false`. Nothing calls Meta, Payment, Fraud, Openpay or invokes the historical WABA message handler.
- Existing R8 `dispatchOnce` remains a **separate** opt-in and is not invoked by this pipeline. Sending a menu at most once would still require separately approved transport credentials and a certified downstream worker.
- H4 session-bound R11 opt-in authorization remains unmounted in the default runtime. Multi-instance session persistence and real CustomerVault/Security/Fraud contract certification remain pending.

## R12 — upstream Payment contract findings (read-only)
Verified on `omarge/businessos-payment-engine` `master`:
- `payment-engine-app/src/main/java/com/businessos/payment/app/authorization/adapter/rest/PaymentAuthorizationController.java`: only conditional inbound `POST /internal/v1/payment-authorizations`, S2S authorized, not a capture/finality query.
- `payment-engine-app/src/main/java/com/businessos/payment/app/authorization/api/PaymentAuthorizationResult.java`: tenant, intent, attempt, result, provider reference and unknown-reconciliation reference.
- `payment-engine-app/src/main/java/com/businessos/payment/app/authorization/api/PaymentAuthorizationStatus.java`: AUTHORIZED/DECLINED/UNKNOWN/PRE_EXECUTION_FAILED/CONFLICT/DENIED.

**Do not treat this as evidence of payment capture or final economic settlement.** An authoritative capture/finalization observation contract is still required, then tenant+intent+attempt correlation, reorder/duplicate/collision testing, outbox receipt dispatch and explicit UAT authorization. No endpoint has been invented.

## CI
PostgreSQL 18 real (temporary GitHub Actions) exercises full WABA suite, multiple competing offline workers, signed menús, financial-looking commands held, quarantines, forced R8 write rollback, reboot/replay and batches >100 events. Do not promote outside offline without GREEN for the exact head SHA and gatekeeper review.
