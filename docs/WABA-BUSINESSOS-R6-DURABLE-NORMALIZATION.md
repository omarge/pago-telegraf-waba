# WABA / BusinessOS R6 — Consumidor de normalización duradero, OFFLINE

## Límite de autoridad
Este consumidor no ejecuta comandos, pagos, notificaciones, respuestas de WhatsApp ni eventos económicos. Solo materializa metadatos deduplicados de eventos Meta ya autenticados y cifrados por el inbox R5. No ejecuta el handler histórico de WABA ni contacta BusinessOS.

## Contrato y recuperación
- `db/waba-r6-channel.sql`: campos de checkpoint/quarantine y tabla `normalized_inbox_events` por identidad teléfono, ID Meta y tipo.
- `src/businessosPgInboxNormalizer.js`: `processNext()` realiza **toda** la normalización dentro de una sola transacción PostgreSQL, `FOR UPDATE SKIP LOCKED` sobre un envelope no consumido, verificación AES-256-GCM y SHA-256, revalidación de cada identidad en el inbox R5, inserción idempotente de facts y checkpoint final antes del COMMIT.
- Si cae PostgreSQL o la operación aborta, la transacción revierte sin marcar procesado. Otro worker puede retomar el envelope al liberar la fila. Si el cifrado, digest o identidad almacenada resultan corruptos, la fila queda `QUARANTINED` con código controlado, sin logs de datos sensibles.
- Los duplicados en envelopes distintos no crean hechos repetidos; múltiples instancias no trabajan la misma fila simultáneamente. No hay cron ni loop automático; solamente invocaciones manuales de prueba por proceso confiable.

## NO_GO público
F09/R5 webhook público sigue sin `durableInbox` en el arranque normal; el normalizador tampoco se monta. No existe consumidor que traduzca mensajes en acciones autorizadas del bot, ni outbox transaccional ni control end-to-end de side effects. Las credenciales del cifrado deben gestionarse fuera de GitHub y con rotación/KMS/retención; `pg` sigue devDependency para pruebas. Falta además habilitar la vinculación async al runtime con Security Engine/Fraud/CustomerVault y finalización canónica de Payment.

PostgreSQL 18 solo en Actions temporal; pruebas de concurrencia, corrupción, crash/rollback y reinicio. No hay comunicación con Meta, PSP o BusinessOS. Draft PR apilado sobre R5, sin merge ni despliegue.