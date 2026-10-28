# WABA F04 — solo Happy Path con tarjeta guardada (Sandbox)

**Trabajo solo en omarge/pago-telegraf-waba.** PR apilado sobre F03. Sin cambios a repositorios Telegram/pagoawaba.

## Camino implementado
1. Cobrador envía 'cobrar' y monto; el bot genera el enlace que ya funcionaba.
2. El pagador abre ese enlace de pago y elige 'Pagar con tarjeta guardada' cuando la funcionalidad Sandbox esté activada.
3. Login web (o registro) y retorno al checkout de esa solicitud.
4. Selección de tarjeta previamente enrolada en Openpay Sandbox, NIP KashBitPay y consentimiento final al importe en MXN.
5. Un POST customer-scoped Openpay Sandbox; después un GET del cargo valida request/order, importe, moneda y estado completed.
6. Se muestra comprobante y se solicita envío de notificación por WhatsApp al cobrador y, si está vinculado, al pagador.

## Controles de activación
- Las nuevas rutas **no envían cargos por defecto**.
- Requiere que el proveedor de enrolamiento F03 se habilite con WABA_CARD_ENROLL_SANDBOX=1, y que WABA_SAVED_CARD_PAY_SANDBOX=1 permita los nuevos cargos.
- La cuenta/NIP requiere KASHBIT_PIN_PEPPER ya configurado. No se ha tocado el .env.
- Solo Openpay Sandbox y tarjetas de prueba. No admite tarjetas reales en el piloto.
- No se reintenta el POST del cargo tras timeout, respuesta indeterminada o consulta no completada. Resultado 'UNKNOWN_SAVED_CARD' debe revisarse manualmente.
- La prueba de CI usa mocks; ningún envío de Meta ni cargo real.

## Lo que NO cambia
- Rutas existentes POST /webhook, GET /webhook, GET /pay/request/:token y POST /pay/charge.
- La tarjeta nueva sigue utilizando el checkout existente, sin cambiar su formulario ni la lógica de cargo.
- No se cambian Meta, Caddy, VPN, puertos, .env, main, deploy ni repositorios externos.

## Alcance Happy Path
- Request y resultado del pago F04 están en memoria del Node.js actual, como el flujo existente. Tras reinicio no se recupera automáticamente una solicitud pendiente.
- Se requiere una sola instancia del servicio; no es una certificación de producción ni de concurrencia distribuida.
- La entrega se certifica con pruebas offline F01-F04 en GitHub Actions. La ejecución con Meta/Openpay Sandbox real requiere autorización posterior.
