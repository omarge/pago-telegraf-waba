# F05 R1 — Certificación de movimientos y comprobante del pago F04 existente

Prerequisito: una transacción Openpay Sandbox ya confirmada por la interfaz F04, con comprobante guardado en `data/waba-statements.json`.

## Estado de la certificación
F04 real: operador reportó pago $10.00 MXN con tarjeta guardada y NIP, marcado como completado el 2026-10-28; ID de solicitud y rastreo disponibles en la conversación. F05: falta verificación post-hoc de diario, estado de cuenta, comprobante y lectura independiente Openpay Sandbox.

## Procedimiento seguro
Desde el host que mantiene los archivos de KashBitPay (no desde GitHub Actions), con la rama F05 y su `.env` ya configurado:
```bash
node scripts/f05-verify-existing-payment.js --request-id KPR-<32_HEX>
```
El comando **solo realiza GET** del cargo Openpay Sandbox customer-scoped (más lecturas de los archivos). **NUNCA** invoca POST /charges, /customers, envía Meta, cambia flags ni escribe a data/.

Verifica: único registro de la solicitud en el diario completado; importe fijo 1000 centavos MXN, tipo y propiedad; misma referencia de comprobante y movimiento del pagador; customer ligado a la tarjeta registrada; GET remoto con `id`, `order_id`, importe, moneda y `completed` idénticos.

Salida sin datos sensibles: `F05_JOURNAL=GREEN`, `F05_STATEMENT=GREEN`, `F05_RECEIPT=GREEN`, `F05_OPENPAY_SANDBOX_GET=GREEN`, `F05_RECONCILIATION=GREEN_READ_ONLY`. Errores sanitizados tipo F05_PROVIDER_MISMATCH.

## Límites
No certifica WhatsApp enviado, un cobrador independiente, durabilidad del request (está en memoria), idempotencia, producción o conciliación bancaria. El arnés F04 local usa el WhatsApp de la cuenta pagadora como requester con Meta notifications no-op, no representa dos participantes reales. Openpay GET confirma proveedor, no liquidación bancaria.

Cero cargos adicionales. Mantener PR Draft sobre rama audit F04; no merges ni deploys.
