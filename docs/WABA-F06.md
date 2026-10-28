# WABA F06 — Happy Path integrado (candidato)

Repositorio único: **omarge/pago-telegraf-waba**. Sin cambios a otros repositorios, main, servidores ni .env.

## Evidencia CI

Suite **HTTP real en loopback + proveedores simulados**, ejecutada en GitHub Actions:
- tests/f06-http-e2e.test.js — 2 pruebas integradas.
- tests/*.test.js — suite acumulada F01–F06: 26 pruebas.
- La refactorización de src/index.js expone createWebhookApp sin arrancar puertos al importarse;
  cuando se ejecuta npm start, continúan funcionando los puertos 8766/8765 originales.
- La refactorización de src/formServer.js expone createFormApp para probar las mismas rutas
  GET /pay/request/:token, POST /pay/charge, /pay/app/* y GET /healthz sin credenciales externas.
- El API, el checkout existente y las rutas de producción conservan sus valores y dependencias
  por defecto, sin habilitar nuevas operaciones con tarjetas.

### E2E A: camino histórico F00
POST /webhook con 'cobrar' -> Meta emulado recibe prompt
-> POST /webhook con '1000' -> enlace /pay/request/:token
-> GET formulario ($10.00 MXN) -> POST /pay/charge con token simulado
-> respuesta de cargo completado -> notificación WABA emulada.
Además valida GET de verificación webhook Meta, healthz y enlace de uso único.

### E2E B: paridad WABA F01-F05
Lista interactiva WABA -> seleccionar Cobrar -> 1000 -> enlace
-> GET checkout con opción tarjeta guardada -> redirect a login
-> login y regreso a la solicitud -> tarjeta guardada, NIP, consentimiento
-> una sola llamada de cargo al adaptador simulado Openpay
-> GET simulado que confirma id/order/importe/moneda/status=completed
-> comprobante persistido en journal de prueba
-> estado de cuenta autenticado -> comprobante web -> avisos simulados a cobrador y pagador.

## Matriz de certificación

| Gate | Estado | Evidencia |
| --- | --- | --- |
| F00: cobro histórico Meta/Openpay Sandbox | GREEN histórico | Logs previos del operador ($10 MXN, completed), no reevaluado en CI |
| F01-F05: regresión offline | GREEN CI | npm test por Actions |
| F06: integración HTTP local con mocks | GREEN CI | tests/f06-http-e2e.test.js |
| F06: cuenta/tarjeta real de Openpay Sandbox | PENDIENTE | Requiere prueba supervisada en instalación aprobada |
| F06: entrega real Meta a ambas partes | PENDIENTE | Requiere mensajes/dispositivos de prueba y webhook desplegado |
| F06: evidencia de comprobante F05 sobre operación real | PENDIENTE | Requiere despliegue F01-F05 y F04 activo |

**No etiquetar F06 como GREEN real mientras los tres últimos gates sigan pendientes.**

## Ceremonia de prueba externa (NO EJECUTAR automáticamente)

1. El operador confirma ventana de pruebas y el despliegue explícito del commit candidato F06.
   Sin esa aprobación, NO se toca la instancia en host, host1, Caddy o Meta.
2. Verificar localmente que el candidato arrancó con npm start y conservó el callback
   /webhook, puerto 8766 y /pay/..., puerto 8765, sin mostrar secretos de .env.
3. Para ruta F00: desde el WhatsApp de pruebas enviar 'cobrar', luego '1000', abrir
   enlace, usar tarjeta de PRUEBA Openpay Sandbox y comprobar 'completed' y aviso.
   Registrar solo ID de solicitud, charge_id y estado, sin PAN/CVV/secretos/token.
4. Para ruta F01–F05: con usuarios de prueba separados, vincular la cuenta web al WhatsApp.
   Enrolar tarjeta de prueba, crear NIP KashBitPay, generar solicitud de $10.00 MXN,
   seleccionar tarjeta guardada, confirmar importe y ejecutar exactamente una operación.
   Las opciones WABA_CARD_ENROLL_SANDBOX y WABA_SAVED_CARD_PAY_SANDBOX permanecen
   desactivadas hasta aprobación explícita del operador; no cambiar ni escribir .env.
5. Consultar Openpay Sandbox por charge_id: el cargo debe estar completed con
   order_id igual a solicitud, moneda MXN e importe 10.00.
6. Verificar que cobrador y pagador recibieron su aviso en el chat esperado; las respuestas
   HTTP 200 de Meta prueban aceptación del API, NO entrega al teléfono.
7. En /pay/app/statement y /pay/app/receipts verificar un solo movimiento/comprobante
   de la operación F04, visible solo en las cuentas correctas.
8. Adjuntar evidencia en el PR o issue con información redactada. Sin GREEN completo,
   mantener PR draft y sin merge.

### Condiciones de parada

- Si Openpay responde de forma indeterminada, NO repetir el cargo; conciliarlo primero.
- Si no llega el mensaje Meta, no inferir entrega por HTTP 200.
- Si un paso falla, no se promociona la rama ni se altera la instalación histórica F00.

## Restricciones
- Sin llamadas reales Meta, Openpay, Caddy, host1 ni VPN en GitHub Actions.
- CI no contiene ni requiere OPENPAY_PRIVATE_KEY ni WABA_TOKEN.
- PR apilado sobre F05; main queda reservado para promoción aprobada por el usuario.
