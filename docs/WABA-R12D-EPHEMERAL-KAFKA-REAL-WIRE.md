# R12-D: Real Kafka protocol CI, ephemeral localhost broker only

This Draft branch is stacked on PR #46 exact SHA `1f763385f1cc1610e927af4cc70a5648bca6d918`. No changes to production, secrets, host1, other repositories, main/master, payment commands or WhatsApp.

GitHub Actions launches **real Apache Kafka 3.9.1 single-node broker** with ephemeral Docker on the isolated CI runner and PostgreSQL 18. A real KafkaJS producer transmits byte-correct PaymentAuthorized canonical Protobuf. The **R12-A+B+C consumer's actual protocol** receives two deliveries (same deterministic owner event ID and SHA, different Kafka offsets). It must persist both durable audit facts with disposition NON_CAPTURE_HOLD, no PAID or receipt. This tests genuine network wire, group assignment, offset progression and replay under an ephemeral local process.

**CRITICAL SECURITY SCOPE:** this broker is intentionally **PLAINTEXT loopback**. Only the **test-injected Kafka factory** substitutes plaintext for the production client’s TLS/SCRAM settings. This is not proof of broker TLS, SASL/SCRAM, producer principal, Kafka ACLs, legitimate Economic Payment Engine publisher or any deployment readiness. The fixture may NEVER be exported to production code. The runtime consumer remains opt-in and unmounted. Transport-authenticated Kafka UAT stays NO_GO pending separately provisioned secure broker and credentials.

The broker is stopped/destroyed by CI. The parallel workflow job runs the entire offline PostgreSQL 18 WABA suite independently. Any successful run is labeled real broker **functional** only, not a certified secure broker.
