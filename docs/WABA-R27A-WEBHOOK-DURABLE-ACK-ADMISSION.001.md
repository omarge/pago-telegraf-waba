# R27-A — Exact startup + ACK admission gate audit

Source SHA `1d6169ef6b75f2e164be288ec69bd90c67df026e`.

## Observed
- `src/businessosDurableIngressBootstrap.js`: `WABA_BUSINESSOS_DURABLE_WEBHOOK` opt-in. Missing/0 -> no durable inbox. 1 requires PG URL, Meta secret, 32-byte AES key, and schema presence, and prevents direct saved-card sandbox charge; initialization fails before the listener opens.
- `src/index.js`: the signed webhook default branch issues HTTP 200 and only then invokes the async handler; handler error after ACK is not recoverable by Meta retry. Opt-in durable branch waits for `persistSignedEnvelope` to complete and maps persisted/duplicate to 200, conflict 409, invalid 400, unverified 403 and DB errors 503.
- Strict inbox has no authorized side-effect worker in this module. Persistent ACK is not a capture or payment confirmation.

## R27 acceptance (must be tested before production promotion)
1. Explicit production/UAT policy requires durable ingress and refuses listener startup if durable mode is off or schema/key unavailable, with no secret logging.
2. Signed envelope persist failure returns 503, never 200; successful durable COMMIT or exact duplicate returns 200; conflicting digest returns 409. Check aborted client connection and process termination just before and after DB commit.
3. Ensure raw signature verification precedes persistence and duplicate identity is scoped; verify exact-byte signature and replay without side effects.
4. Ensure no direct PSP dispatch and no WhatsApp confirmation from durable inbox ACK; separate worker authority remains disabled.
5. Test with focused offline HTTP and disposable PG18 only after a narrowly scoped implementation; no blanket regression for documents.

This PR is documentation only. No external repo/host/Meta/PSP access, no deployment, no workflow, no secret. production_go=NO_GO.
