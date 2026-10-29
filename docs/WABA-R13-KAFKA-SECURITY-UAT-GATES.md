# R13 Kafka secured deployment preflight — NOT BROKER CERTIFICATION

Source audit performed read-only against `omarge/businessos-payment-engine/master`: `PaymentCanonicalEventRelay.java`, `PaymentCanonicalEventOutbox.java`, `SpringCanonicalPaymentEventEmitter.java`. Producer has durable outbox, Protobuf topic `businessos.payment.events.v1`, key `tenant|payment_id`, canonical headers, and dark mode by default. No evidence was produced that a WABA consumer principal is provisioned or authorized on any live broker.

**This branch** adds a pure, no-I/O check of topic, brokers, pinned consumer principal/group, TLS `rejectUnauthorized=true`, SCRAM-SHA-512, manual offsets, disabled auto topic creation and absence of test-only injected Kafka constructor. Even a shape-valid configuration returns `CONFIG_SHAPE_ONLY`, `mayConnect=false`, `isBrokerCertified=false`, `productionGo=false`.

To certify UAT separately: verify exact broker CA/hostname chain, secure listener, SCRAM-512 login, topic READ/DESCRIBE and consumer group permissions, distinct producer principal WRITE-only, deny unauthorized consumers and untrusted producers, manual offset and rebalance under failure, auditable credential rotation and no leakage. Do not use test plaintext brokers as an equivalent.

**Cost:** no new Actions workflow; targeted Node tests only, no runtime integration. Future UAT requires explicit authorized credentials and expensive targeted broker tests only once. No host1, .env, main/master, Payment Engine edits, payments or Meta sends. NO_GO.
