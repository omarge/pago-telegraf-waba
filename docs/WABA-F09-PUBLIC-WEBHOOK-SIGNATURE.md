# WABA F09 — Firma de webhook Meta obligatoria (OFFLINE)

## Cambio verificado
Antes F09, POST /webhook en src/index.js devolvía HTTP 200 sin firma y ejecutaba la lógica de mensajes. El RED-first previo (commit 92de18f) registró cinco pruebas adversariales fallidas.

En el candidato se verifica X-Hub-Signature-256 con HMAC-SHA256 sobre los **bytes HTTP originales**, antes de JSON.parse, antes del HTTP 200 y antes de ejecutar el handler. Se reutiliza verifySignature() del módulo F06 previamente probado. No cambia ningún contrato ni cifrado de Openpay o BusinessOS.

- WABA_APP_SECRET es el **Meta App Secret**, separado de WABA_TOKEN (Bearer) y WABA_VERIFY_TOKEN (challenge GET). Si falta o es demasiado corto, POST devuelve HTTP 503, sin invocar el bot. No se registran secretos.
- Sin firma, firma errónea o contenido alterado: HTTP 403; Content-Type equivocado: 415; >64 KiB: 413; JSON o envelope Meta inválido: 400.
- La verificación GET de suscripción Meta sigue funcionando con WABA_VERIFY_TOKEN.
- Los E2E históricos F06 y F07 ahora generan firmas válidas solamente con App Secret falso inyectado en los fixtures. No se envían mensajes ni cargos reales.

## Procedimiento de verificación sin despliegue
1. Abrir PR Draft #22 y sus GitHub Actions. Verificar test F09, F06 HTTP, F07 y regresión completa en el SHA final.
2. No modificar el .env del operador ni crear una credencial en el servidor desde este PR.
3. Cuando Meta apruebe el nombre y el usuario autorice UAT, obtener WABA_APP_SECRET desde Meta App Dashboard y provisionarlo de forma privada. No pegarlo en chat ni en reportes.
4. Desplegar solamente tras aprobación específica en un UAT aislado y confirmar que GET challenge y POST firmado funcionan; HMAC inválido debe resultar 403 y no ejecutar acciones.

## NO_GO público persistente
Este gate certifica autenticación HTTP, **NO** idempotencia de mensajes ni persistencia durable. El webhook aún envía HTTP 200 luego de validar la firma pero antes de durabilizar eventos. src/store.js mantiene Map de invitaciones y solicitudes; un reinicio pierde datos, y R5 es solo un prototipo de un escritor sin garantía de producción. Meta seguía PENDING_REVIEW en la última consulta real, WABA_TEST_TO estaba ON, y no existe autorización de despliegue.

Por ello **F09 CI GREEN != UAT pública GREEN**. Ningún commit de este PR altera main, producción, secretos, Caddy, Openpay ni BusinessOS.
