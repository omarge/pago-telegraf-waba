# R18 — Kafka replay collision across ALL deliveries and bounded economic history

**Base:** certified Draft PR #67 exact `313faf9f5daa745f4306bf84371bc36cca819acf`. Two independent WABA branches were built from this exact base and combined here before running one financial PostgreSQL18 certification. Only WABA's existing unmounted financial/evidence adapters changed.

## R18-A — same event ID, multiple deliveries, contradictory digest

Source: `src/businessosR12KafkaCommitProcessor.js`. Each Kafka record first undergoes schema/source validation and the event identity is serialized with a PostgreSQL transaction advisory lock. The previous query `SELECT ... WHERE event_id=$1 LIMIT 1 FOR UPDATE` could encounter one matching delivery and overlook a different persisted row using the same event ID but a conflicting payload, type or tenant/attempt. This risk arises if a historical import/corrupted durable row exists despite normal writes being idempotent.

The new verification checks **all returned rows** under the existing advisory lock. The query is capped at **4,097 rows**: if more than 4,096 replay entries are present, it refuses the record rather than assuming an incomplete scan is clean. Any conflict or excessive replay produces `EVENT_ID_OR_OFFSET_COLLISION_HOLD` with **no Kafka offset ACK and no economic action**. Original exact duplicate delivery at a new offset remains admissible. The cap does not grant skip/recovery authority.

**Real PG18 test:** A clean canonical `PaymentAuthorized` delivery is audited, a contradictory second delivery with the SAME event ID is seeded at another partition/offset, and a third clean replay is attempted. The consumer must HOLD the replay without committing the new offset, even if a previously matching row is encountered first.

## R18-B — bounded economic projection

Source: `src/businessosR12EconomicReversalHoldProjection.js`. An otherwise read-only tenant+payment-intent projection previously queried all canonical ingress events with no limit. A Kafka replay storm can produce arbitrarily many observed rows. The projection now fetches **up to 4,097** records on its PostgreSQL `REPEATABLE READ READ ONLY` snapshot; if there are more than 4,096, it returns `CANONICAL_HISTORY_LIMIT_HOLD`, with no paid/finality, receipt or notification permissions. It does not display a false clean capture while evidence is truncated.

**Real PG18 test:** insert exactly 4,096 additional noncapture ingress rows plus one prior matching capture for the same tenant/intent, then require `CANONICAL_HISTORY_LIMIT_HOLD`.

## Cost and safety

Both fixes touch durable economic-evidence classification and Kafka offset-admission authority, so **one exact-SHA R12 F+G PostgreSQL18 regression** is justified. The consolidated workflow already includes a full PG18 suite, cross-module PG18 HOLD test and Kafka constructor policy tests. Do not re-run real Kafka brokers or Payment Engine/Security suites; no new workflow is added.

All outcomes remain `isPaid=false`, `canSendReceipt=false`, `canSendWhatsApp=false`. Original Payment Engine upstream #80/#81 and Payment #13/Merchant #10 authority GO gates are still open, and authenticated broker UAT is not certified. No `main`/`master`, server, `.env`, secret, external repo write, PSP or Meta effect. **`production_go=NO_GO`**.
