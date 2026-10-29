# R12-H — Kafka authenticated UAT evidence gate (offline, no broker contact)

## Sources inspected (read only)

Real Payment Engine upstream: `omarge/businessos-payment-engine`, branch `master`, files:
- `payment-engine-app/src/main/java/com/businessos/payment/app/integration/canonical/PaymentCanonicalEventRelay.java`
- `payment-engine-app/src/main/java/com/businessos/payment/app/integration/canonical/PaymentCanonicalEventProperties.java`
- `payment-engine-app/src/main/java/com/businessos/payment/app/integration/canonical/SpringCanonicalPaymentEventEmitter.java`

Payment Engine uses `businessos.payment.events.v1` with canonical Protobuf, Kafka key `tenant|paymentId`, outbox and producer `payment-engine`. The producer code is disabled by default; enabled mode calls `requireValidOrFail()`. Crucial gap: `requireValidOrFail()` checks that `security.protocol` **contains** `SASL`; its documented example includes **`SASL_PLAINTEXT`**. This condition proves neither `SASL_SSL` nor a verified broker TLS chain. The WABA consumer source requests `ssl.rejectUnauthorized=true` and `scram-sha-512`, but no real secure broker, principal or ACL proof is available in the reviewed artifacts. **Do not infer compatible or approved deployment from code alone.**

## Independent operational checks still required

1. **TLS certificate chain:** secure broker with CA trust and certificate identity verification; record sanitized certificate SHA256 and reviewer evidence; reject plaintext.
2. **Producer authentication/ACL:** Payment Engine principal `payment-engine`, SCRAM-SHA-512 and WRITE exclusively to canonical topic; unauthorized producer DENIED.
3. **Consumer authentication/ACL:** separate WABA principal with READ topic and group, no WRITE; unauthorized consumer DENIED.
4. **Namespace isolation:** cross-tenant adversarial attempts and topic permissions demonstrated on the actual approved isolated UAT cluster.
5. **Source and recovery:** producer event_ID replay, consumer committed offsets, rebalance, HOLD/unknowns and no economic notifications after broker crash/recovery, with evidence artifacts.
6. **Security approval:** independent human review of logs/ACL policy/certificate validation and explicit management authorization before ever changing the WABA dark-mode flag.

`audit/r12/kafka-security-preflight.js` accepts only metadata and evidence **shape**; it contains **no Kafka client, secrets or network calls**. It rejects `SASL_PLAINTEXT`, wrong principal, missing proof, mismatched topic, unrecognized secret-bearing fields. Even a syntactically perfect manifest returns `INDEPENDENT_SECURITY_REVIEW_REQUIRED` with `securityCertified=false, canEnableKafka=false, productionGo=false`: anyone can forge input JSON; a real independent TLS+ACL audit remains required.

Existing [PR #53](https://github.com/omarge/pago-telegraf-waba/pull/53) remains Draft; historical 11/11 checks GREEN, but they were **not** secure broker authentication certification. The actual upstream Payment Engine configuration is read only; **no change was made** to Payment Engine, no live broker or credentials touched, no Actions intentionally invoked for this audit-only change. `production_go=NO_GO`.
