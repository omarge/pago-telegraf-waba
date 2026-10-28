# WABA F02: sesión web y vinculación voluntaria

Estado: candidato aislado y dependiente de F01. No hay despliegue, merge a main, ni cambios a Telegram.

## Happy path
1. Abrir /pay/app/register por HTTPS, crear cuenta WABA propia con correo y contraseña.
2. La sesión se maneja por cookie Secure y HttpOnly. /pay/app/account muestra correo y vínculo WhatsApp.
3. En /pay/app/bind generar código de un solo uso; enviar desde el WhatsApp que se desea asociar un mensaje "vincular CODIGO".
4. El webhook asocia el remitente entrante a la cuenta web que emitió el código. Responde con resultado; no registra el código en logs.
5. El usuario ve el estado del vínculo en su cuenta. El botón cerrar sesión revoca la cookie.

## Alcance
- Los usuarios son propios de WABA; no están federados con Telegram, Openpay ni ningún proveedor de identidad externo.
- No se permite deducir la titularidad de una cuenta a partir del teléfono de WhatsApp.
- El almacén de cuentas es un JSON local persistente en data/waba-accounts.json, excluido de Git. Solo almacena hash scrypt de contraseña y asociación WA; no guarda tokens de sesión ni códigos.
- Sesiones y códigos temporales se pierden tras reinicio; los usuarios y vínculos persisten.
- Las páginas de tarjetas, NIP, movimientos y configuración aún muestran módulos en preparación y no realizan operaciones.
- Sin cambios al checkout de pago actual, Meta, Openpay, Caddy, VPN, puertos ni .env.
- Para evitar confundir identidad, el código de vínculo usa el remitente de webhook, nunca WABA_TEST_TO.
- En una futura implementación de F03, es necesaria una federación verificada para acceder a tarjetas realmente existentes en otros sistemas.

## Pruebas
npm install --ignore-scripts --no-audit --no-fund
node --test tests/*.test.js

Las pruebas usan loopback, cuentas sintéticas y directorios temporales. No se mandan mensajes ni cargos reales.
