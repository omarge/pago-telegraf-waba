# BusinessOS R8 — Canal WABA: outbox segura, entrega at-most-once (OFFLINE)

## Principio financiero
BusinessOS Payment Engine es dueño de ejecución y recuperación de pagos. Este R8 no despacha autorizaciones, no llama BusinessOS, no toca Openpay, no envía mensajes Meta reales y no genera comprobantes. Solo la respuesta **pública y no financiera de menú** puede convertirse en una intención de salida, con transporte inyectado para pruebas.

## Flujo propuesto
R5 signed encrypted ingress → R6 normalized facts → R7 `MENU_CANDIDATE` → R8 `safe_menu_outbox` en PostgreSQL.
`stage({phoneNumberId,messageId})` crea una fila por clave estable del mensaje autenticado; solo `MESSAGE` marcado `MENU_CANDIDATE` en R7 y envelope normalizado/no cuarentenado. Comandos `pagar`, `cobrar`, `tarjetas`, `nip`, estados Meta y eventos no firmados no pueden entrar.
`reserve()` verifica GCM + digest + identidad firmada R5, obtiene destinatario **únicamente** del cuerpo original autenticado, cambia READY→UNKNOWN_HOLD en una transacción y hace COMMIT antes de permitir efecto externo. `dispatchOnce()` ejecuta una única llamada a transporte **inyectado y desactivado por defecto**, siempre un texto fijo, sin importes, identificadores de cuenta ni links. Una aceptación válida del proveedor produce `PROVIDER_ACCEPTED_NOT_DELIVERED`, nunca estado PAID, enviado/entregado o capturado.
Ante crash después del COMMIT y antes/durante el POST externo, queda `UNKNOWN_HOLD` para revisión humana. No hay retry automático, incluso si se perdió una respuesta. Esto ofrece **at-most-once attempt** por fila, NO exactamente-once delivery, ni garantía de entrega. Una caída entre reserva y POST puede suprimir una respuesta inocua de menú; preferimos eso a generar duplicados/economía inesperada.

## Pruebas y límites
PostgreSQL 18 real de GitHub Actions, transporte fake sin Meta, prueba de >10 consumidores concurrentes, replays tras reinicio, fallo previo a reserva, fallo de respuesta/timeout y fallo al escribir aceptación; cero retry externo, guardado del ACK y ausencia de PII/bearer en outbox.
Este PR no conecta nada al startup del bot, no provisiona Security Engine ni hace llamadas externas. El dispatcher financiero **no existe**. R7 `AWAITING_SECURITY_ENGINE` es un bloqueo, no una ruta a ejecutor económico. Próximo gate requiere principal S2S real y mecanismo autoritativo de customer/vault/fraud además de operación económica confirmada. Sin merge a main ni deploy.