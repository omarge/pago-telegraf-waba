# R15 — Kafka topic + consumer-group ACL inspection (non-authoritative)

## Source and API evidence

KafkaJS [Admin Client documentation](https://kafka.js.org/docs/admin) describes `admin.describeAcls` with Kafka `AclResourceTypes`, `AclOperationTypes`, `AclPermissionTypes` and `ResourcePatternTypes`. These supported operations are read-only metadata requests. The source pinned to this R15 branch is still KafkaJS `^2.2.4` as shown in `package.json`; the CLI does not access any real cluster unless explicitly authorized and `R14_KAFKA_PROBE_ENABLED=1`.

**Finding R14:** the previous probe described only the Kafka **TOPIC** ACL. Kafka authorizations also govern the WABA **GROUP**. Returning 'ACL description' for topic only was an incomplete observation.

## Remediation

`src/businessosR14SecuredKafkaReadOnlyProbe.js` now requests two separate metadata ACL filters:
1. `AclResourceTypes.TOPIC`, canonical topic `businessos.payment.events.v1`, `AclOperationTypes.ANY`, `AclPermissionTypes.ANY`, `ResourcePatternTypes.MATCH`.
2. `AclResourceTypes.GROUP`, exact configured WABA `groupId`, same read-only filters.

Any exception/malformed response on topic returns `ACL_INSPECTION_UNAVAILABLE_HOLD`; on group returns `GROUP_ACL_INSPECTION_UNAVAILABLE_HOLD`. If either collection is empty, return `ACL_POLICY_EMPTY_HOLD`: a default-allow Kafka cluster or no visible ACL is not permission evidence. Even both populated descriptions only return `BROKER_METADATA_OBSERVED_PENDING_INDEPENDENT_AUDIT`.

No ACL principals, raw resource names, hosts, credentials, CA PEM or broker IDs are emitted. A valid response is **not** proof that the consumer can read assigned partitions, that an outsider is denied, that the producer identity is correct, or that the broker uses deny-by-default; independent UAT negative tests are mandatory. This does not test Kafka group join, message consumption or offset commits.

The R15 adversarial tests use a fake Kafka admin (topic ACL PASS, group ACL error, missing group ACL, malformed private CA). No real network or broker authentication is attempted.

## Source authority boundary

Payment Engine's canonical Kafka relay is configured for the topic with idempotent publication and transactional owner outbox. This describes *transport* authority, not financial finality. No WABA startup import of this probe, no producer/consumer construction, no acknowledgement, no Meta/PSP requests.

## Certification and cost

Use the existing one-job Node24 R13/R14 targeted workflow only, which already runs `tests/businessos-r13-*.test.js`. **No** PostgreSQL18, Docker, real Kafka service, or full WABA regression for this isolated unmounted probe change. Changes are Draft only, `production_go=NO_GO`.
