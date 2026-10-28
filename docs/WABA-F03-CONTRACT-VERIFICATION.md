# WABA F03 — Contract check and real-world gate

Only happy path card enrollment and PIN, no idempotency gate and NO charges.

Offline tests use an in-memory HTTPS transport: POST /customers, POST /customers/{customerId}/cards, GET card, safe errors, disabled charges. No Openpay/Meta calls.

Operator-supplied evidence: local vault has customerId=false, cards=0 and pin=true. Read-only Sandbox scan for recently created customers matched zero current web-account email addresses. Root cause is not known without a new instrumented error stage.

External supervised gate: keep saved-card charging disabled. From the candidate commit, perform one controlled Sandbox test-card enrollment, capture only stage, numeric Openpay HTTP/code, and masked outcome. Never share PAN, CVV, token ID, device session, password or PIN. If creation or verification fails, consult read-only provider records before considering another attempt. No server or env edits from GitHub.

Meta name_status=PENDING_REVIEW and code 131037 affects WhatsApp response, not web enrollment.