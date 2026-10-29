# R12-D+E: Real ephemeral Kafka + local economic reversal HOLD (integration)

**Lineage:** starts at independently GREEN [PR #47](https://github.com/omarge/pago-telegraf-waba/pull/47) SHA `df37a51e754616da980bd4331911a2a585a55162`, then copies source/test blobs from independently GREEN [PR #48](https://github.com/omarge/pago-telegraf-waba/pull/48) SHA `82db3b96b01edd45e4fbbb5423193760850bf412`. This is a new stacked Draft branch only, no parent PR merged and no modifications outside WABA.

**Real broker functional integration:** GitHub Actions creates disposable Apache Kafka 3.9.1 and real PostgreSQL 18. KafkaJS produces original Payment Engine Protobuf fixtures on the real wire. WABA's actual R12-ABC consumer code, with test-only local plaintext transport factory, receives two repeated PaymentAuthorized deliveries (same deterministic economic event ID, separate Kafka offsets, both durable NON_CAPTURE_HOLD), then a PaymentCaptured fact matching an existing R11 authorization handoff, then PaymentRefunded for that exact intent and attempt. SQL evidence must prove:
1. Two authorized deliveries are distinct Kafka audit rows with identical event ID/hash and no payment effects;
2. PaymentCaptured is one durable CANDIDATE_ONLY, while the R12-E projection returns **CAPTURE_CANDIDATE_RECONCILIATION_PENDING**, never PAID;
3. After the real Kafka refund arrives, the read-only projection returns **REVERSAL_UNKNOWN_OR_FAILURE_HOLD**, with the capture candidate unchanged and no paid/receipt or notification.

**Source authority limitation:** this Kafka broker is REAL but intentionally uses *localhost plaintext in the test harness*. It is not a secure broker certification. Production code still demands TLS/SCRAM-512 and remains unmounted, no real Payment Engine producer or PSP/network calls, no WABA Meta sends. The projection is read-only, receives *locally observed* economic facts, does not verify real provider reconciliation or bank settlement and never certifies finality.

GitHub Actions simultaneously runs the real broker path and entire offline PostgreSQL 18 regression. Main/master, actual host1, production secrets, payments, .env and BusinessOS financial repositories untouched. `production_go=NO_GO`.

**Remaining GO gates:** genuine Kafka TLS/SASL/SCRAM and ACL/producer verification with approved credentials; source event completeness, unknown/late refund/capture dispute reconciliation from Payment Engine authoritative read model; multi-node rebalance and poison operations with real broker; real Security/CustomerVault/Fraud, UAT and Payment Engine production GO. No R13 receipt.
