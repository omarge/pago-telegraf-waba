# F04 R2 — Prueba web real controlada sin WhatsApp

La prueba F03 real guardó una Mastercard Sandbox enmascarada ****4444 y un NIP; el envío Meta sigue bloqueado por 131037 / PENDING_REVIEW.

El script `scripts/f04-local-sandbox.js` permite preparar **una solicitud de $10.00 MXN Sandbox en memoria**, sin mensajes Meta, sin tocar Caddy, servicios activos, .env ni repositorios externos. No inicia cargo por sí mismo. Solo escucha en 127.0.0.1:18768. No es para producción.

## Preflight (solo lectura; se puede ejecutar con npm start abierto)

```bash
cd ~/bc/proyectos/pago-telegraf-waba
git fetch origin
git switch --track origin/audit/waba-f04-happy-path-saved-card-pin-20261028
set -a; source .env; set +a
node scripts/f04-local-sandbox.js --preflight
```

Debe reportar exactamente una cuenta web vinculada con una tarjeta Sandbox propia y NIP configurado: `F04_PREFLIGHT=GREEN_READ_ONLY`. Si hay cero o varias, detenerse.

## Ejecución real (solo con autorización explícita del operador)

1. Detener `npm start` en `geo@host`; el script también bloquea si hay listener local en 8765 para impedir escritura concurrente.
2. En ese host, con `.env` ya cargado (sin editarlo), ejecutar:
```bash
WABA_SAVED_CARD_PAY_SANDBOX=1 node scripts/f04-local-sandbox.js --authorize-sandbox-10-mxn
```
3. Desde el navegador **del mismo host** abrir la URL `F04_URL=http://127.0.0.1:18768/pay/app/pay/...`. Si se usa otro equipo, se necesita un túnel explícito a loopback; no publicar este puerto ni crear una ruta en Caddy.
4. Iniciar sesión en la cuenta web que contiene la Mastercard guardada. Verificar el importe fijo de $10.00 MXN, seleccionar tarjeta enmascarada, introducir el NIP en el navegador y confirmar una sola vez.
5. Verificar el resultado en la página y, si se completó, en `/pay/app/statement` y el dashboard Sandbox. No compartir el NIP, tokens, customer IDs, card IDs ni PAN/CVV.
6. Ante resultado pendiente o incierto, **NO REINTENTAR**. Revisar estado del cargo en Sandbox de solo lectura.

Nota: el número de referencia del cobrador dentro de este arnés local es el WhatsApp ya vinculado de la cuenta de prueba, solo para satisfacer la estructura del diario; no valida liquidación entre dos personas ni notificaciones. Las notificaciones Meta son intencionalmente no-op.

No es certificación de idempotencia, durabilidad de solicitudes tras reinicio, concurrencia, producción ni envío bilateral. El PR permanece DRAFT.