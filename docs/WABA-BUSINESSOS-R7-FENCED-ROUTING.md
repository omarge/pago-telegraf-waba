# BusinessOS R7 — Enrutamiento duradero y autoridad delegada (candidato offline)

## Contratos comprobados (solo lectura)
En `omarge/businessos-security-engine/main`, `ServiceAuthorizationController` expone POST `/internal/security/v1/service/authorize`. El caller presenta su credencial **de servicio** y pide scope TENANT, `audience=Payment` y `permission=payment.authorize`. El Security Engine resuelve el tenant AUTORIZADO; la solicitud es intención, no autoridad. Respuesta 200 `allowed=true` con token delegado y actor vinculados; 401/403/503 son rechazos y no se procede.
El `ServiceValidationController` expone POST `/internal/security/v1/service/validate` y exige tenant/scope/permission/audience, con estado de autoridad real en PostgreSQL de Security Engine. Ninguna decisión puede inventarse en WABA.

## Qué implementa R7
- `src/businessosSecurityDelegationGate.js`: construye intención exacta TENANT/Payment/payment.authorize, comprueba igualdad completa de respuesta ALLOW y token delegado solo en memoria. Transport se inyecta para testing; falta conectar al Security Engine bajo credencial segura. Por defecto `DISABLED`.
- `db/waba-r7-channel.sql`: staging transaccional de rutas de evento Meta normalizadas. Clave única de evento; sin cuerpo PII, tokens ni referencias de tarjeta.
- `src/businessosPgRoutingGate.js`: obtiene hechos R6 con `FOR UPDATE SKIP LOCKED`, verifica GCM + digest + identidad firmada normalizada, clasifica 'menu' como `MENU_CANDIDATE`, comandos potencialmente financieros como `AWAITING_SECURITY_ENGINE`, el resto `IGNORED_UNKNOWN` o `REQUIRES_REVIEW`; inserta decisión y checkpoint implícito de una sola vez en COMMIT. La decisión **no ejecuta** el handler del bot ni ningún API.
- Duplicados y crashes/rollback no crean dos decisiones. No hay temporizadores, loops, env flags ni nuevas rutas HTTP; solo invocación de pruebas con PostgreSQL 18 aislado.

## Seguridad y limitaciones
`AWAITING_SECURITY_ENGINE` nunca equivale a autoridad. Tener la palabra pagar, un tenant proporcionado por browser o un teléfono enlazado no prueba el derecho a ejecutar un pago. Falta unificar identidad del usuario, CustomerVault y Fraud con la autoridad delegada. Un `AUTHORIZED` financiero jamás es `PAID` sin captura/confirmación Payment Engine.

**NO_GO operativo**: falta una outbox de notificaciones y procesador de comandos que garantice idempotencia del efecto externo; R7 únicamente prepara decisiones. La conexión S2S real a Security Engine está intencionadamente desactivada hasta aprobación de credenciales, permisos y UAT. Meta, Openpay y BusinessOS no se consultan en tests. `main`, `master`, `.env`, hosts y repos BusinessOS intactos.