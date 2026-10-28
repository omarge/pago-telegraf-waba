# WABA F03 — tarjeta guardada y NIP web (Sandbox opt-in)

PR dependiente de F02; NO merge, deploy, cambios a Caddy, .env ni otros repositorios.

## Implementado
- /pay/app/cards: lista referencias enmascaradas realmente persistidas y pertenecientes a la cuenta web autenticada.
- /pay/app/enroll: cuando se habilite Openpay Sandbox de forma explícita, captura datos SOLO en Openpay.js y envía al backend token_id y device_session_id, consentimiento y datos de cliente. El servidor no recibe PAN ni CVV.
- Cliente Openpay ligado al ID de cuenta web WABA, tarjeta guardada en su subrecurso customer-scoped, seguida de GET de verificación del ID, customer_id y últimos cuatro.
- /pay/app/pin: crear y cambiar NIP de cuatro dígitos tras confirmar contraseña de cuenta; hash HMAC-pepper + scrypt con sal, sin guardar texto claro ni enviar NIP por WhatsApp.
- Persistencia en data/waba-vault.json, excluida de Git.
- Pruebas offline con fake Openpay, aislamiento de cuentas, sesiones, CSRF, persistencia y regresión de F01/F02.

## Política de activación
- El proveedor de tarjetas está desactivado por defecto. Solo se crea cuando WABA_CARD_ENROLL_SANDBOX=1 y existen variables OPENPAY_MERCHANT_ID, OPENPAY_PRIVATE_KEY, OPENPAY_PUBLIC_KEY.
- Por defecto no se envía ninguna operación a Openpay; el checkout de pago ya existente sigue igual.
- NIP disponible solamente cuando KASHBIT_PIN_PEPPER tiene al menos 32 caracteres. No cambiar secretos existentes durante esta fase.
- No se realizan cargos desde las nuevas microaplicaciones. OneClick se implementará en F04, independientemente de un enrolamiento.
- Los usuarios de WABA todavía no están federados con los de Telegram. No se importan tarjetas ni PIN del bot Telegram.

## Limitaciones de la fase
- Sin operador autorizando despliegue y sandbox real, el proveedor y sus resultados siguen SIN VERIFICACIÓN EXTERNA.
- JSON local de una sola instancia no soporta alta concurrencia entre múltiples procesos; se requiere evolución a almacenamiento transaccional antes de un despliegue multiproceso.
- Una respuesta indeterminada del proveedor debe conciliarse manualmente antes de reintentar enrolamiento; no hay blind retry.
- La recuperación del NIP se hace mediante contraseña de la cuenta web, no por WhatsApp ni con un NIP bancario.
- Openpay.js deviceData, Caddy real y binding de usuarios requieren prueba manual antes de habilitar tarjetas de prueba.

## Ejecución CI
npm install --ignore-scripts --no-audit --no-fund
node --test tests/*.test.js
