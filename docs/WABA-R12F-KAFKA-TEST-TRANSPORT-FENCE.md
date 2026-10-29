# R12-F — Prevent test Kafka transport override in ordinary runtime

**Stacked Draft from certified #49. No production activation.**

### Demonstrated gap
The R12 rebalance and older secured Kafka consumers exposed `kafkaFactory` for offline tests. Even though normal Kafka configuration requires TLS server validation and SASL/SCRAM-512, an injected factory can ignore those settings (the real ephemeral plaintext CI fixture intentionally demonstrates that). That constructor injection was not restricted to tests.

### Guardrail
Both consumers now refuse `start()` with `TEST_TRANSPORT_OVERRIDE_REJECTED_NO_CONNECT` when `kafkaFactory` is supplied outside the Node `--test` child process (`NODE_TEST_CONTEXT`). No Kafka connection or database call occurs on the refusal path. CI regression runs both ordinary-process negative tests and in-test constructor fixtures. If `enabled=false`, the consumer remains dark.

**This is a runtime misuse guardrail, not a security boundary against a malicious party able to set arbitrary process environment variables or edit the deployed package.** Test-only factory support should eventually be moved behind a separately packaged test harness; production deployment must load only immutable reviewed application startup code, enforce real TLS CA, SASL/SCRAM, topic ACLs and producer principal independently, and never mount an injected fake.

### Scope
No listener is mounted. No broker credentials, host, `.env`, main/master, other repos, PSP, Payment Engine production sender, Meta or WABA receipt are touched. The existing ephemeral Kafka action remains functional CI only; authenticated Kafka UAT and economic finality are still **NO_GO**.
