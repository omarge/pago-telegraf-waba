# F06 R5 — Signed webhook ingress and private restart-safe evidence (OFFLINE)

Status: candidate Draft ONLY. Blocked real integration because Meta sender name PENDING_REVIEW and WABA_TEST_TO=ON.

## Implemented
- `src/f06DeliveryEvidence.js`: strictly validated snapshot export/import for offline evidence, no changes to Meta message sending, webhook in production or Openpay.
- `src/f06EvidenceLedger.js`: local private JSON file mode 0600 containing linked message IDs and recipient numbers (PII). HMAC integrity tag with domain-separated key derived from supplied test app secret; atomic write/rename and fail-closed on corruption, wrong file permissions, signature mismatch or invalid snapshot.
- `src/f06IsolatedStatusApp.js`: **isolated** Express app only, receives `POST /f06/status` with raw `application/json` body (64 KB max). HMAC-SHA256 verification via R4 model is mandatory before admitting a status. Unverified POST → 403; malformed signed bodies → 400. Accepted state updates commit to the private ledger before sending HTTP 200. No call to Meta / Openpay, and absolutely no deployment or changes to live src/index.js / src/webhook.js / src/savedCardFlow.js / src/waba.js.
- `tests/f06-r5-signed-ingress.test.js`: signed HTTP, recovery after process recreation, replay/duplicate, missing signature, mismatched roles, file tampering and permissions; fake key, fake Meta data and loopback only.

## Certification limits
This is an offline R5 prototype, **not** a production-safe ledger:
- one writer process only, no lock/distributed concurrency, reconciliation, or external durable DB;
- file snapshots contain recipient numbers and message IDs; protect access and ensure private storage; never attach to Actions or publish;
- no real outbound accepted-message capture, no live webhook route or notification delivery is certified;
- pending Meta review and test override remain strict blockers; no repeat charges;
- `main` untouched, PR Draft and no `.env` changes, no real network calls.

Before any deployment or integration, review Meta signature verification at the public ingress, webhook response ordering, message ID correlation, storage encryption/retention, coordinated persistence/transaction boundaries and crash recovery. Authorize separate deployment explicitly.
