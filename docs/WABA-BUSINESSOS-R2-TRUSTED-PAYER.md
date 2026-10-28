# R2 WABA BusinessOS: pagador autenticado y vinculación obligatoria



F09/R1 sobre rama aislada; BusinessOS Payment y Security Engine solo lectura, main/master intactos.

R1 permitía consultar un request por ID sin demostrar que estuviera asignado a la cuenta de pagador; además, devolvía resultados cacheados con esa misma ID.

R2 exige request.payerAccountId===accountId antes de resolver autoridad y antes de leer cache de intentos, y revalida asignación, importe y estado tras el await de la autoridad.

El endpoint opcional GET/POST /pay/app/businessos/authorize/:requestId solo se monta si el servidor recibe businessosFlow.isEnabled=true. createAccountRouter utiliza sesión y CSRF que ya existen; GET es solo lectura y el POST exige consentimiento. No acepta del browser ningún tenant, importe, cliente, fraud decision, tarjeta ni bearer.

AUTHORIZED solo genera HTTP 202 (autorización pendiente de captura); UNKNOWN 202 con aviso no reintentar. No se inserta PAID, recibos ni notificaciones. El adaptador no está conectado en el arranque normal.

IMPORTANTE: las invitaciones actuales son solicitudes PENDING no asignadas a una cuenta BusinessOS; R2 **bloquea** esas solicitudes. Aún falta un binding seguro y duradero de pagador canónico, y conectores Security Engine, CustomerVault y Fraud reales. No debe habilitarse todavía.

NO_GO hasta que exista persistencia/identidad confiable, certificación BusinessOS Payment y autorización explícita de despliegue. Pruebas loopback y PSP falso únicamente.