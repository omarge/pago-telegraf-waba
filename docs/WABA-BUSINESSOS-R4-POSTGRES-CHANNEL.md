# BusinessOS WABA R4 — PostgreSQL transactional channel gates (offline)



Se implementó un repositorio nuevo y AISLADO para solicitudes del **canal WABA** y deduplicación de eventos; NO es un ledger financiero ni reemplaza BusinessOS Payment Engine.



## Componentes

- `db/waba-r4-channel.sql`: tablas en esquema `waba_channel` con PK y checks de solicitud, digest del evento y reserva de autorización de un solo uso.

- `src/businessosPgChannelStore.js`: operaciones `createRequest`, `bindPayer`, `getRequest`, `admitSignedEvent` y `reserveAuthorization` en transacciones PostgreSQL; row locks para vincular pagadores o reservar autorización; duplicados y conflictos retornan estados separados.

- Se añade `pg` únicamente como dependencia de desarrollo para CI; `pool` debe inyectarse explícitamente. No se modifica `src/store.js`, webhook de Meta ni flujo financiero directo.

- `admitSignedEvent` se considera una API interna para un **caller de confianza que ya verificó la firma**. El parámetro `signatureVerified` no constituye prueba criptográfica por sí mismo: el webhook de producción debe llamar al verificador F09 con el cuerpo original, extraer campos validados y luego persistirlos antes de HTTP 200. R4 no conecta ese circuito.

- La reserva `RESERVED_NO_AUTO_RETRY` crea un candado durable antes del POST futuro a BusinessOS; los intentos posteriores, incluso tras reinicio, reciben `HOLD_NO_AUTO_RETRY` hasta revisión. Esta fase **NO envía** el POST ni automatiza recuperación.



## Certificación

GitHub Action con PostgreSQL 18 real en contenedor del runner, sin secretos, credenciales solo de prueba y datos de ejemplo. Pruebas: idempotencia de solicitud, monto/propietario, compare-and-set concurrente, inbox por estado y mensaje, colisiones, reserva de autorización concurrente y recuperación tras reconectar a PostgreSQL, además de las regresiones completas.



## Límites y NO_GO

Esta es una API transaccional candidata, **no conectada** al servidor WABA. No se ha completado una transacción conjunta entre el claim de R3 y la solicitud de R4: el siguiente gate deberá migrar el claim a la misma base o definir una transacción fiable. No se distribuye un secreto de claim por canales reales; tampoco hay consumer de inbox, reintentos controlados ni status final canónico BusinessOS. Se mantienen el HMAC de F09, separación tenant/CustomerVault/Fraud y Security Engine como futuros requisitos.

El estado de Payment Engine y de Meta continúa NO_GO para pagos/WhatsApp reales. main, master, env y hosts intactos.