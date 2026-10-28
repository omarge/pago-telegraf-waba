# F04 R1 — Happy Path with saved Mastercard and KashBitPay PIN

Dependency: F03 (2026-10-28) user-confirmed Openpay Sandbox enrollment success: mastercard masked ****4444, persisted in My Cards; PIN configured.
This PR is stacked on F03; keep both DRAFT, do not merge main.

## Implemented
- F04 regular-POST payment form explicitly fills its deviceSessionId field from the value returned by OpenPay.deviceData.setup. It uses a separate generated-element name to avoid the empty/duplicate hidden input defect previously proven in F03.
- Browser VM regression checks the returned Openpay ID reaches the submitted hidden field, and invalid device fails closed.
- Offline provider contract tests verify customer-scoped POST /charges with source_id, order_id, currency, amount and device_session_id; GET /charges/{id}; runtime flag disable. All calls use in-memory mock HTTPS, **no transactions**.
- Existing flow tests simulate PIN validation, provider GET and completed, and receipts without Meta or Openpay access.

## Not authorized or certified here
- **No Sandbox charge performed.** Existing payment flag remains off; never change .env remotely, issue actual charge, or deploy.
- No production release; no bank/PSP contract changes, no idempotency certification.
- Real F04 requires a user-initiated limited-cost Openpay Sandbox test with explicit consent, correct linked account, saved card and NIP. Do not attempt while Meta display name pending unless acceptable that notifications may fail.
- Persisted payment state is currently in memory. Do not assert production-grade durability.
