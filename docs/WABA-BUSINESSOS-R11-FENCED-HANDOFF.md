# WABA / BusinessOS R11 — Pre-commit económico y reserva irreversible (OFFLINE)

## Propósito
R11 prepara una **única** llamada simulada al Payment Engine solo después de que una solicitud existente, vinculada al pagador, haya sido comprobada, haya obtenido evidencia canónica R10 y se haya registrado una reserva PostgreSQL. No hay un dispatcher/endpoint operativo: el adaptador es inyectado y queda desactivado en el arranque normal WABA.

## Orden de autoridad
1. Lectura segura `waba_channel.requests` (PostgreSQL), payer ligado, estado PENDING, importe MXN exacto y `createdAt` original (no se regeneran timestamps).
2. Puerto inyectado R10 `prepareEvidence.prepare()` (identidad CustomerVault canónica, Fraud y Security Engine simulados); estado únicamente `EVIDENCE_CANDIDATE_OFFLINE_ONLY`. Resolver separado de autoridad de Payment vincula tenant/customer/assessment y token delegado, que jamás se persiste.
3. `buildAuthorizationRequest()` crea los DTO/ids estables R1. La autoridad se comprueba contra la evidencia, no se deriva de la sesión o JSON del navegador.
4. Transacción de `SELECT ... FOR UPDATE` sobre request: revalida owner, estado, importe, requester, currency y timestamp después de todo `await`. Inserta en el **mismo COMMIT** el `authorization_reservations` antiguo R4 y `payment_authorization_handoffs` R11, incluyendo `fraud_assessment_id` y digest irreversible de material del método. Nunca guarda bearer ni referencia opaca del medio.
5. Solo si el COMMIT devuelve `RESERVED` se invoca **una vez** `adapter.authorize()` (fake en CI). Toda carrera, 5xx, socket reset o fallo después de reserva permanece `UNKNOWN_HOLD`, sin reintento automático ni redispatch.
6. `AUTHORIZED` registra `AUTHORIZED_PENDING_CAPTURE_NOT_PAID` únicamente si coincide el par intent/attempt determinístico devuelto. No se registra `PAID`, no se crea recibo ni se invoca captura. `DECLINED` o rechazo quedan registrados sin liberar el fence.

## Limitaciones y NO_GO
**El código no es una orquestación financiera productiva**: los puertos de CustomerVault/Fraud/Security son inyectados y los tests son fakes. R10 no ofrece un comprobante cryptográfico de respuesta Fraud ni el endpoint CustomerVault productivo. El Payment Engine se mantiene NO_GO por sus propias certificaciones. La condición `enabled=true` solo se ejerce con fake adapter en pruebas; no está montada en `src/index.js`, no usa credenciales reales, ni tiene autorización para emitir pagos.
R11 debe certificar el mismo comportamiento con un servicio Security Engine y fraude auténticos, integración con el nuevo storage async y observación posterior, además de proteger cambios concurrentes de los puertos de origen. Una caída entre reserva y POST puede suprimir el intento; la seguridad de no duplicar prevalece sobre disponibilidad. No se recomienda reenviar automáticamente ni siquiera con idempotencyKey sin un protocolo de recuperación autoritativa.
PostgreSQL 18 exclusivo del runner, sin modificaciones a main/master, .env, host, Meta, PSP, BusinessOS real o repositorios distintos.