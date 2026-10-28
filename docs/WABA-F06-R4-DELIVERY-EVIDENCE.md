# F06 R4 — Evidencia de entrega WhatsApp, 100% offline

## Estado externo
Las verificaciones reales anteriores demostraron `F06_LINKED_ACCOUNTS=2`, `F06_DISTINCT_DESTINATIONS=2`, `WABA_TEST_TO=ON` y `F06_META_NAME_STATUS=PENDING_REVIEW` (Graph GET). No se envían mensajes ni se activan cargos.

## Qué prepara esta fase
Se añade `src/f06DeliveryEvidence.js`: un **modelo aislado de pruebas**, **NO conectado al webhook de producción**. Solo registra como `ACCEPTED_BY_META` una respuesta aceptada con `messages[0].id` y después valida estados de webhook `sent`, `delivered`, `read`, `failed` por `wamid` y destinatario, con verificación HMAC del cuerpo original, `phone_number_id` esperado y seguimiento de los roles `PAYER` y `COLLECTOR`.

El módulo rechaza firma ausente o errónea, destinatario cambiado, `WABA_TEST_TO` activo, respuesta Meta sin ID, y replays que intenten regredir `read -> delivered`. Los estados fuera de orden no destruyen evidencia superior. La marca `failed` no se confunde con entrega. Solo se almacena código numérico seguro, sin detalles de error. La capacidad está acotada, sin escritura de archivos ni llamadas externas; simula end-to-end sólo mediante pruebas en memoria.

**Importante**: los GREEN de Actions son únicamente offline. La evidencia que produce la suite **no acredita recepción real**. El módulo no persiste datos, no reemplaza el registro de notificaciones de producción, y no modifica `src/index.js`, `src/webhook.js`, `src/savedCardFlow.js`, `src/waba.js` ni la configuración del operador. Antes de conectar webhooks reales se requerirá una fase específica de autorización e integración firmada y persistente; no debe aceptarse un POST recibido sin verificar la firma de Meta.

## Matriz de gates
| Gate | Estado |
|---|---|
| F03–F05 Openpay Sandbox | GREEN real histórico del operador |
| Dos destinatarios diferentes | GREEN real |
| F06 firma, estados, duplicados y out-of-order | GREEN sólo cuando CI confirme |
| F06 ruteo | BLOCKED: WABA_TEST_TO=ON |
| F06 remitente Meta | BLOCKED: PENDING_REVIEW |
| F06 entrega a cobrador y pagador | NO CERTIFICADA |
| Durabilidad y seguridad de webhook real | NO INTEGRADA |

Ningún pago, mensaje Meta, cambio de .env o modificación de main se autorizó en esta fase.

Fuente Meta: https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications
