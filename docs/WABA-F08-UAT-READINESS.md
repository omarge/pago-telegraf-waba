# KashBitPay WABA F08 — Preparación UAT Happy Path

## Decisión de seguridad
La versión de `src/formServer.js` anterior a F08 permitía `POST /pay/charge` con importe, token y destinatario recibidos del navegador y usaba las credenciales Openpay si estaban configuradas, sin validar la solicitud del servidor. **No puede exponerse esa ruta en una UAT pública.**

F08 implementa un bloqueo **por defecto**: `createFormApp()` no habilita `POST /pay/charge` y la página `/pay/request/:token` ya no ofrece el formulario de tarjeta nueva que lo invocaba. El flujo Happy Path de **tarjeta guardada + NIP autenticado** se mantiene. Para proteger la regresión histórica F00, la prueba offline con PSP falso puede llamar `createFormApp({legacyChargeEnabled:true,charge:fake})`; ese opt-in de pruebas NO lo usa `startFormServer()` y NO se expone por `.env`.

**RED-first:** run de GitHub en SHA `d65a549` muestra fallo al exigir cierre default del endpoint legacy. La corrección se limita al startup/checkout legado, sin cambiar firmas, cifrado, PSP adapter, API BusinessOS ni añadir cargo.

## Preflight NO-GO
El script `scripts/f08-uat-readiness.js` es de solo lectura y no contacta a Meta ni Openpay:
```bash
node scripts/f08-uat-readiness.js
```
Con los hechos comprobados en código y la última consulta real de Meta, los blockers conocidos:
- Nombre del remitente Meta `PENDING_REVIEW` (el script no lo consulta y trata cualquier estado no comprobado como bloqueo).
- `WABA_TEST_TO=ON`; los avisos pueden ir al teléfono de pruebas.
- Webhook público `src/index.js` confirma HTTP 200 antes de verificar firmas: **no admitir estados de entrega como confiables en la entrada pública**.
- `src/store.js` conserva solicitudes de pago en un `Map`: no hay durabilidad tras reinicio.
- Falta autorización de despliegue y prueba real.

El resultado esperado es `F08_UAT_GATE=PUBLIC_UAT_NO_GO`, **aunque 100% de los Actions resulten GREEN**. Esta herramienta no modifica `.env`, rutas, datos ni servidores. Los blockers son una lista deliberadamente conservadora basada en código auditado; al cambiar el código debe actualizarse el gate con nuevas pruebas independientes.

## Procedimiento de futura UAT, SIN EJECUTAR
1. Obtener autorización del usuario para entorno UAT aislado, nunca producción.
2. Asegurar ingesta WABA firmada con HMAC en el webhook público, control de replays/errores y almacenamiento duradero de solicitudes; no usar el prototipo R5 local de un solo escritor como si fuera producción.
3. Verificar nombre Meta `APPROVED`, dos WhatsApps distintos y autorización explícita antes de retirar el redirect de pruebas.
4. Verificar en GitHub Actions F03–F08 0 fallos, con PSP y Meta simulados; registrar SHA exacto y no fusionar `main`.
5. Preparar backup y rollback del proceso UAT. El rollback no debe reactivar `POST /pay/charge` abierto.
6. Solo después, probar mensajes de dos dispositivos bajo ventana aprobada; **no efectuar cargos Openpay adicionales** sin consentimiento expreso. No asumir entrega por respuesta Meta HTTP 200.
7. Reconfirmar que BusinessOS sigue en `LOCAL_REFERENCE_ONLY`, sin envíos ni eventos canónicos.

Rango de este PR: UAT preflight + seguridad del endpoint histórico + regresión offline, **no certificación de uso público**.
