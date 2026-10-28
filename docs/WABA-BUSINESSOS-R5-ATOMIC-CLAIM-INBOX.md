# WABA BusinessOS R5: PostgreSQL atomic payer claim and signed encrypted inbox



Isolated offline candidate only. New tables in waba_channel, no changes to BusinessOS schemas.

R3 local file claim is retained for regression but is not used together with R5. R5 issues one secret only to trusted server code, persists its hash as a row referencing the same durable request, and claims with SELECT FOR UPDATE on requests followed by payer_claims. Request owner and used claim change together in ONE COMMIT, with 15-minute expiry and no reissue once claimed.

R5 optional createWebhookApp({durableInbox}) path first checks F09 raw-body Meta HMAC. Then the new PostgreSQL inbox repeats HMAC validation, encrypts the original full envelope using AES-256-GCM with an injected key, and atomically stores the encrypted envelope and R4 unique inbox event identities. Duplicate webhook gives 200 without dispatching. Conflicting identity returns 409 and rolls back; failed DB returns 503 without ACK. No message-processing worker exists, so the optional mode intentionally NEVER invokes onWebhook; the default server does not supply durableInbox and is unchanged.

R5 is not live integrated. There is no server-side delivery of claim secret, no migration from R3 local file, no KMS/key rotation/retention controls for WhatsApp PII, no inbox consumer or BusinessOS completion, and no live Security Engine/Fraud/CustomerVault connection.

R2 BusinessOS authorization flow still expects a synchronous getRequest, whereas PostgreSQL uses an asynchronous pool. DO NOT inject R5 directly into the R2 web router until explicit async authorization and DB transaction-scoped concurrency are certified. The real Meta/PSP/BusinessOS paths remain disabled and NO_GO. No deploy, no main/master merge, no changes to secrets.