# R26-A — Webhook ingress ACK and durable delivery audit

Source: WABA R25 exact SHA `1d6169ef6b75f2e164be288ec69bd90c67df026e`, `src/index.js`.

## Source-backed observation

The default `startWabaServer()` enables `durableInbox` only if `createDurableIngress({env})` returns an inbox. In `createWebhookApp`, when `durableInbox === null`, the signed Meta webhook is acknowledged HTTP 200 **before** `onWebhook(body)` runs. Failure in the asynchronous handler is logged after the ACK and cannot trigger a Meta retry. Source explicitly says this path is not UAT-ready. When a validated durable inbox is injected, HTTP 200 is only sent after `persistSignedEnvelope` returns `STORED` or `DUPLICATE`; conflict / unverified / unavailable are rejected.

## Release gate

Do not equate a 200 on the legacy/default ingress with durable financial processing. Positive UAT certification requires fail-closed durable ingress configuration, signed exact-byte verification, persisted encrypted envelope, ACK-after-commit proof, duplicate replay, DB failure/no ACK, worker restart and no event loss. Confirm the deployment actually uses strict ingress; this document does not claim host configuration. The optional inbox has no authorized worker here; a durable ACK is not financial confirmation.

No live Meta traffic, notifications, secrets, UAT host or workflow executed. No production source change, no PAID or receipt. production_go=NO_GO.
