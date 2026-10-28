# F06 R3 — Comprobación READ ONLY del nombre de Meta

El operador reportó 2 cuentas vinculadas y dos destinos diferentes: `F06_LINKED_ACCOUNTS=2`, `F06_DISTINCT_DESTINATIONS=2`. Persisten `WABA_TEST_TO=ON` y Meta HTTP 400 code 131037 al intentar responder desde el bot.

El código 131037 corresponde al **nombre del remitente WhatsApp Business no aprobado**; no depende del número de cuentas vinculadas. Referencia oficial de ejemplo Meta: https://www.postman.com/meta/whatsapp-business-platform/request/uaptswv/get-business-phone-number-display-name-status-beta

`scripts/f06-meta-name-status.js` hace **una sola consulta HTTPS GET** al número emisor `/v26.0/{WABA_PHONE_ID}?fields=name_status`, con el token local. **Jamás** llama `/messages`, `/register`, Openpay ni modifica credenciales, archivos o .env. Solo imprime valores de estado permitidos, sin números ni tokens.

Ejecutar únicamente en `geo@host` con las variables habituales ya configuradas:

```bash
node scripts/f06-meta-name-status.js
```

Resultados:
- `F06_META_NAME_STATUS=PENDING_REVIEW` y `F06_META_GATE=BLOCKED_PENDING_NAME_REVIEW`: no enviar más pruebas; esperar aprobación en Meta.
- `DECLINED`: revisar nombre en Meta Business Suite, Phone numbers.
- `APPROVED` o `AVAILABLE_WITHOUT_REVIEW`: nombre apto, **no** entrega certificada y `WABA_TEST_TO` todavía bloquea routing bilateral.
- `STATUS_UNAVAILABLE_CHECK_WHATSAPP_MANAGER`: el campo `name_status` es beta y puede no estar disponible según token o número; comprobar WhatsApp Manager por UI, no inferir aprobación.

Referencias adicionales: https://www.postman.com/meta/whatsapp-business-platform/request/tsxl0ng/get-display-name-status-beta y https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/

F06 sigue NO_GO hasta ruteo bilateral sin override, aprobación Meta y confirmación independiente de entrega a ambos teléfonos. Sin despliegues, sin cargos adicionales; `main` y `.env` intactos.
