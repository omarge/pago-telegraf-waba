# F06 R1 — Preflight de ruteo WhatsApp bilateral (sin pagos)

## Estado previo demostrado
F03/F04/F05 GREEN real Openpay Sandbox y comprobante por $10.00 MXN. **No implica entrega WhatsApp**. Meta retornó error 131037 con display name PENDING_REVIEW en evidencia previa; debe verificarse estado actual en Meta de forma independiente antes de enviar.

## Riesgo identificado
`src/waba.js` contiene `TEST_TO = process.env.WABA_TEST_TO || ''` y `normalizePhone` devuelve ese TEST_TO cuando existe. Los intentos nominales hacia cobrador y pagador se convierten en **un solo destinatario** mientras la variable está configurada. En `src/savedCardFlow.js` los errores de notificación se silencian para no deshacer un pago completado; `noticesAttempted` no es entrega.

## Preflight en geo@host
Desde el root del repositorio con la rama F06 de auditoría y su .env local existente (solo lectura):
```bash
node scripts/f06-routing-preflight.js
```
Lee `data/waba-accounts.json` y las variables cargadas. No conecta con Meta ni Openpay, no envía mensajes, no modifica .env ni archivos. No expone WhatsApp, emails, tokens ni IDs.

Salida:
- `F06_ROUTING_PREFLIGHT=BLOCKED_TEST_TO_REDIRECT`: existe WABA_TEST_TO; no se puede certificar la entrega a dos destinatarios.
- `F06_ROUTING_PREFLIGHT=BLOCKED_NEED_TWO_DISTINCT_WHATSAPP_ACCOUNTS`: no hay dos cuentas vinculadas a números diferentes (incluyendo equivalencia 521/52).
- `F06_ROUTING_PREFLIGHT=BLOCKED_META_CONFIG_MISSING`: faltan variables de Meta.
- `F06_ROUTING_PREFLIGHT=CONFIG_READY_META_UNVERIFIED`: ruteo configurado, pero todavía **no** se ha certificado aprobación Meta, aceptación API, entrega en dispositivos, ni test bilateral. No representa GREEN real.

**El comando puede terminar exit code 2 intencionalmente para un bloqueo de readiness**. Jamás ocultarlo, forzar flags, ni desactivar WABA_TEST_TO en producción automáticamente.

## Lo que falta para cierre F06
1. Meta name status APPROVED y envío permitido (el error 131037 debe resolverse en Meta). Solo el operador verifica panel de Meta, sin entregar tokens.
2. Dos cuentas web con WhatsApps realmente distintos, enlazadas mediante flujo ya existente; sin WABA_TEST_TO que sobrescriba destinatarios.
3. Una prueba supervisada independiente de mensaje/aviso a ambos chats y evidencia de entrega. **No realizar un nuevo cargo automáticamente.** Puede hacerse una validación de transporte sin cobrar bajo autorización explícita del operador.
4. Separar: Meta HTTP 2xx+message ID acredita aceptación del API, no entrega al teléfono; para entrega hace falta evidencia de webhook de estados o confirmación en dispositivo.
5. Evitar reproducir identificadores sensibles del usuario en logs o CI. Mantener PRs DRAFT; main y .env intocados.

## Certificación GitHub Actions
El nuevo workflow ejecuta únicamente pruebas offline; sus GREEN no equivalen a Meta real. No integra ni altera rutas de cobro, PSP o notificaciones en runtime.

## R2 — Diagnóstico de bloqueos simultáneos (evidencia real)
Preflight operador: `F06_LINKED_ACCOUNTS=1`, `F06_DISTINCT_DESTINATIONS=1`, `F06_TEST_TO_OVERRIDE=ON`, `F06_ROUTING_PREFLIGHT=BLOCKED_TEST_TO_REDIRECT`. Es una evaluación ordenada; también falta un segundo WhatsApp vinculado. Se agrega `F06_BLOCKERS` para mostrar **ambos motivos**, sin imprimir números ni secretos. No habilitar notificaciones ni modificar `.env` automáticamente. Se requiere vincular segunda cuenta por flujo UI autenticado y una decisión controlada del operador sobre el override de pruebas, previa verificación de Meta.
