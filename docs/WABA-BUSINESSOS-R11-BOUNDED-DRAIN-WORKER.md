# R11 Bounded Durable Drain Worker — offline certification

**Draft PR #38** stacked on #37; `production_go=NO_GO`.

## Verified architecture and constraints

The worker is intentionally **not mounted** in `src/index.js` and has no auto-start, cron, timers, Meta transport or Financial dispatcher. The historical WABA pilot remains unaffected. This phase provides a bounded, manually invoked server-side drain that can later be supervised after separate UAT approval.

`createR11OfflineDrainWorker({pool,encryptionKey,enabled:true}).runOnce({limit:8,envelopeDigest:null})` scans **only durable PostgreSQL evidence**, not a caller-supplied message or browser field. Accepted selectors are an optional lowercase SHA-256 signed envelope digest and a bounded integer batch limit 1–32.

The backlog predicate includes exactly the three recoverable boundaries:
- R5 envelope not yet normalized by R6;
- R6 normalized facts missing R7 classification;
- R7 safe-menu route missing R8 outbox staging.

Quarantined envelopes are excluded. The existing `createR11OfflineInboundPipeline` performs the signed GCM verification, deduplication, routing and safe-menu staging. Financial commands stay `AWAITING_SECURITY_ENGINE`, Meta status notifications cannot enter the safe-menu outbox, and no browser or WhatsApp text acts as financial authority.

### Outcomes

- `DISABLED`: worker opt-in flag not enabled.
- `INVALID`: non-hex digest, malformed bound or type, no DB access.
- `IDLE_NO_EFFECT`: no pending envelope.
- `DRAINED_OFFLINE_NO_DISPATCH`: selected items reached a durable terminal staging state.
- `MORE_WORK_OFFLINE_NO_DISPATCH`: bounded page full or a partial 100-item envelope, safe to invoke again.
- `RETRYABLE_NO_EFFECT`: query/commit interrupted; no external side effects were attempted.
- `HALTED_NO_EFFECT`: unexpected local stage condition; operator review required.

**All returns are offline-only.** No state implies an actual Meta send, payment authorization, capture, settlement or receipt. A concurrent worker may legitimately find no work after another commits. Backlog volume and latency have not been benchmarked; queue indexes, operational monitoring and scheduler ownership remain future phases.

## Tests

PostgreSQL 18 Actions exercise individual signed menus, financial command hold, Meta status, 12 concurrent workers, restart using a new pool, rollback after R7 COMMIT/before R8 INSERT, AES-GCM corruption, DB outages and 150-event bounded envelopes. The entire WABA regression suite must be GREEN at the exact HEAD before promotion.

## Prohibited until separate approval

No automatic polling or deployment; no Meta sender or provider credentials; no enabling `WABA_BUSINESSOS_DURABLE_WEBHOOK` on production without authorized worker and end-to-end UX; no direct PSP charging from the BusinessOS channel. R12 remains blocked on an authoritative BusinessOS economic finality/capture contract. The authorization-only REST interface is **not** a capture confirmation.

No changes to main/master, host1, .env or any BusinessOS source code.
