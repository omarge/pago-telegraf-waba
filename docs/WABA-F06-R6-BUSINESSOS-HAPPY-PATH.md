# WABA F06 R6 — Happy Path hoy, integración BusinessOS después

## Decisión arquitectónica

**KashBitPay WABA** es el **canal de experiencia**. Su alcance piloto es: `cobrar` → enlace → usuario autenticado → tarjeta guardada/NIP → Openpay Sandbox → GET de verificación `completed` → comprobante en el diario local → preferencia/aviso WhatsApp (cuando Meta apruebe el emisor).

**BusinessOS** asumirá la responsabilidad de integración financiera cuando exista un contrato acordado y una autorización de despliegue. No implementar aquí motor financiero distribuido, pagos productivos, Kafka, outbox, conciliación o transacciones BusinessOS.

Referencia técnica real (SOLO LECTURA) consultada:
- [businessos-aggregator-integration — catálogo de contratos v1](https://github.com/omarge/businessos-aggregator-integration/blob/main/contracts/docs/CONTRACT-CATALOG-v1.md)
- [OWNERSHIP MAP](https://github.com/omarge/businessos-aggregator-integration/blob/main/contracts/docs/OWNERSHIP-MAP.md)
- [IDEMPOTENCY RULES](https://github.com/omarge/businessos-aggregator-integration/blob/main/contracts/docs/IDEMPOTENCY-RULES.md)

BusinessOS tiene autoridad sobre `PaymentCaptured` y comandos `AuthorizePayment`/`CapturePayment` en el motor Payment. Sus metadatos requieren tenant validado e idempotencia, y la cantidad de `Money.amount_decimal` es decimal exacto. WABA NO conoce aún el `tenant_id` autorizado, identidad de productor BusinessOS o mapping canónico; un comprobante Openpay Sandbox no puede convertirse arbitrariamente en un evento económico BusinessOS.

## Implementación R6

`src/businessosPaymentReference.js` crea **solo una referencia local informativa**, leyendo exclusivamente `journal.receiptForAccount` para el pagador, con estado `completed` y origen `openpay_saved_card_sandbox`. Contiene `requestId`, `providerChargeId`, moneda MXN, importe decimal exacto en cadena y un `dedupeHint` determinista. No incluye números de WhatsApp, tarjetas, contraseñas, NIP, tokens, tenant, idempotencia canónica ni autorización para ejecutar movimientos.

API:
```js
const {createVerifiedPaymentReference}=require('./src/businessosPaymentReference');
const candidate=createVerifiedPaymentReference({
  accountId,requestId,journal,accounts
});
// candidate === null si el usuario no es pagador o no existe comprobante.
```

**No hay** llamadas a BusinessOS, `send()`, `dispatch()`, `POST`, `event_id` ni `PaymentCaptured`. El candidato es un puente de lectura para diseñar la integración futura; `integrationState=LOCAL_REFERENCE_ONLY` y `businessosAuthority=NONE`. El receptor BusinessOS real deberá adoptar/transformar explícitamente y validar tenant, metadata, idempotencia, PSP provenance y ownership antes de generar comandos/eventos. No publicar automáticamente en Kafka.

## Alcance y gates
| Gate | Estado |
|---|---|
| F03–F05 Happy Path Sandbox real | GREEN ya certificado por operador |
| F06 canal WhatsApp bidireccional en pruebas HTTP | GREEN offline |
| F06 aviso real WhatsApp | BLOQUEADO por nombre Meta PENDING_REVIEW y WABA_TEST_TO=ON |
| R6 candidato de referencia al contrato BusinessOS | CERTIFICACIÓN OFFLINE con CI |
| Contrato formal BusinessOS / tenant / adapter | FUTURO, no aprobado ni implementado |
| Live BusinessOS integration | NO_GO |

Los PRs son Draft y `main`/producción/`.env` están protegidos. No volver a cobrar $10 ni enviar pruebas mientras Meta siga revisando. Los prototipos de estados R4/R5 son material de certificación, no dependencia obligatoria del Happy Path.
