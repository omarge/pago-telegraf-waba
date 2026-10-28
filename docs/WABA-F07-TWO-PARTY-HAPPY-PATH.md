# WABA F07 — Happy Path integrado con dos participantes, RED-first

Candidato de certificación **100% offline**. No llamar Meta ni Openpay, no crear cargos, no usar cuentas reales y no desplegar.

## Alcance
- Cobrador y pagador independientes vinculados a diferentes WhatsApp simulados, más una tercera cuenta ajena.
- Webhook HTTP local → menú → Cobrar → 1000 → enlace de invitación consumible una vez.
- Pago web del pagador con sesión, tarjeta guardada de prueba, NIP, CSRF y consentimiento.
- Provider fake: **una sola operación POST simulada**, GET simulado autoritativo, diario F05 y dos avisos fake.
- Comprobante y estado de cuenta accesibles al pagador y al cobrador, pero **NO** a un tercero.
- Repetición de la confirmación: no crea segundo cargo ni notificación, y el comprobante no debe mostrar `NaN` o `undefined`.
- Dos POST concurrentes mientras un PSP de prueba responde lentamente: solo un POST fake.
- Resultado indeterminado de PSP de prueba → `UNKNOWN_SAVED_CARD`; no `PAID`, sin comprobantes ni reintentos.
- Una referencia local para futura integración BusinessOS, sin atribuir eventos, tenant ni movimiento canónico.

La prueba de reintento en un pago `PAID` se escribe **RED-first** para detectar la omisión de importe en la rama de resultado ya completado. En un commit posterior se corregirá únicamente la respuesta ya completada, sin alterar el estado ni el proveedor.

## Gates externos
Meta sigue `PENDING_REVIEW` y `WABA_TEST_TO=ON`; ningún test de GitHub acredita la entrega a un teléfono. La referencia BusinessOS sigue `LOCAL_REFERENCE_ONLY`. F07 GREEN de CI solo certifica paridad local con mocks.

No modificar `main`, `.env`, Caddy, servidores ni otro repositorio. Draft PR apilado sobre R6.

## RED-first y remediación R2
En SHA `89e9640`, F07 demostró mediante HTTP en loopback que el segundo POST a una solicitud `PAID` devolvía el recibo con `$NaN MXN`, porque la rama idempotente no incluía `amountCents`. Se corrige **solo el DTO de replay PAID** preservando el importe desde la solicitud, sin ejecutar PSP, registrar nuevos movimientos ni notificar. La suite exige además `Importe: $10.00 MXN` en el recibo repetido.
