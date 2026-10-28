# WABA ↔ BusinessOS R3 — Persistencia de reclamación del pagador, piloto offline

## Propósito y límite
En R2 el canal exigía request.payerAccountId pero nadie podía establecerlo de manera segura. R3 agrega una reclamación de un solo uso para solicitudes PENDING, con pagador autenticado y WhatsApp vinculado, CSRF y consentimiento. Una invitación pública o conocer la KPR no da permiso financiero.

## Implementación
- Módulo aislado `createPayerClaimLedger({filePath,integrityKey,requestStore})` sin autoarranque. `issue({requestId})` solo se invoca desde código confiable del servidor una vez generada/validada la solicitud. Devuelve un secreto de 32 bytes que **no se imprime ni se guarda en claro**. No existe endpoint HTTP para emitir un código.
- `claim()` exige código, sesión y WhatsApp vinculado, CSRF confirmado por router, request PENDING, importe/requesterId sin cambios y vencimiento de 15 minutos. El primero que posee la capacidad y la sesión puede reclamar; otros usuarios y replays quedan bloqueados. No asume que WhatsApp identifique un cliente canónico de BusinessOS.
- Archivo privado 0600 en directorio 0700, HMAC de integridad, fsync archivo y directorio, reemplazo atómico, y lock de un único escritor: una segunda instancia falla. Tras caída con lock huérfano la reapertura es NO_GO hasta revisión manual, nunca auto-takeover.
- `getRequest()` adapta el objeto de request para la frontera R2 sin mutar `src/store.js` ni los objetos de `SavedCardFlow`; revalida ancla y monta `payerAccountId` únicamente si sigue presente el request original, con monto y requester coincidentes.
- `GET/POST /pay/app/businessos/claim/:requestId` solo se monta junto con BusinessOSFlow habilitado e inyectado y el Ledger; login, CSRF, WhatsApp vinculado, consentimiento, secreto de reclamo, sin envío al PSP.

## Gatekeeper NO_GO
**No es la durabilidad de la solicitud completa ni solución multi-host**: los registros de solicitud originales siguen en `src/store.js` Map. Si el request desaparece después de reiniciar, se bloquea incluso si existe el claim persistido. El lock de un escritor es local; faltan PostgreSQL/transacciones/CAS distribuidos y recuperación de autorización. La identidad del pagador solo es una cuenta WABA; falta resolver en servidor, de modo autoritativo, Security Engine tenant, CustomerVault, Fraud y método de pago. Falta integrar la emisión del secreto en un checkout aprobado, sin exponerlo en URL/logs. Ninguna ruta se ha desplegado.

Solo pruebas offline con dispositivos falsos, Openpay/Meta/BusinessOS no llamados, ningún cambio a main/master/.env/host. No se declara UAT ni GO.
