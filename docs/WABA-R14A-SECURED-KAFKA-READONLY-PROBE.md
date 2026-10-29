# R14-A — Secured Kafka read-only metadata/ACL inspection, never consumer startup

**Goal:** provide a real (not self-reported) metadata check against an independently authorized secure UAT broker, without reading customer or payment messages, publishing, advancing offsets or changing ACLs. This is an **operator-controlled inspection tool**, not a payment integration or a production GO.

## Source

- `src/businessosR14SecuredKafkaReadOnlyProbe.js`: defaults to `enabled=false`. Uses the same Kafka topic and basic config validation as the existing R12 secured consumer. When explicitly enabled, constructs KafkaJS with `ssl.rejectUnauthorized=true`, `sasl.mechanism=scram-sha-512`, bounded connect/request timeouts and `retry.retries=0`; optionally accepts CA PEM from approved configuration. It constructs **admin only**, performs `connect`, `fetchTopicMetadata` for the canonical Payment topic, and attempts read-only `describeAcls`. It then disconnects.
- `scripts/r14-kafka-readonly-probe.js`: manual-only command-line wrapper, **not imported by the WABA application**, reads its **own** `R14_KAFKA_*` environment keys only; does not parse `.env`. It always prints an allowlisted, sanitized state and never prints user, password, CA, broker hostname, provider data or the raw ACL principals.
- `tests/businessos-r13-kafka-readonly-probe.test.js`: fake-admin tests with all connection methods intercepted; no broker or credentials in CI.

## Safe execution policy

By default, this command is dark:

```bash
node scripts/r14-kafka-readonly-probe.js
```

To use it against a *separately approved* secured UAT broker, the operator must first export explicit `R14_KAFKA_PROBE_ENABLED=1`, `R14_KAFKA_BROKERS`, `R14_KAFKA_CLIENT_ID`, `R14_KAFKA_GROUP_ID`, `R14_KAFKA_USERNAME`, `R14_KAFKA_PASSWORD`, and optionally `R14_KAFKA_CA_PEM`. **Do not execute against production or from GitHub Actions without the user's separate authorization and actual UAT credentials.** No values should be pasted into PRs, CI logs or tickets.

A successful metadata call may demonstrate that a client with supplied TLS/SCRAM options connected and could describe topic metadata. ACL listing can legitimately be unavailable to least-privilege WABA readers; that condition is **HOLD**, never an ACL success claim. Even a returned ACL list **cannot prove** a distinct producer's principal identity or negative authorization results. Those need an independent authorized Kafka security review with negative principal tests.

The state `BROKER_METADATA_OBSERVED_PENDING_INDEPENDENT_AUDIT` means only metadata and a self-observed ACL describe response. `isBrokerCertified`, `isAclCertified`, `isProducerAuthenticated`, `isPaid`, `mayConsumeMessages`, `mayCommitOffsets`, `canSendReceipt`, and `productionGo` are always false. No consumer or producer is constructed.

## Cost and release boundaries

A **single existing targeted Node 24** workflow can run the offline fake tests after R14 is included in its file paths. There is no need for PostgreSQL18, Docker, Kafka emulator or broad WABA regression when only adding this *unmounted* tool. The actual UAT metadata call is not part of CI and remains unauthorized until specific operator approval. Production remains `NO_GO`.

Only WABA Draft branch files change. No main/master, host1, .env, secrets, Payment Engine edits, PSP calls or Meta sends.
