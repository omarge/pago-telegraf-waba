# WABA F05 — configuración, estado de cuenta y comprobantes (Happy Path)

Candidato aislado en omarge/pago-telegraf-waba, PR dependiente de F04. Sin cambios a repositorios externos.

## Funcionalidad
- /pay/app/settings: alias y preferencia de avisos de recibos por WhatsApp, guardados en cuenta autenticada.
- /pay/app/statement: movimientos registrados para esta cuenta, solo cargos completados del nuevo camino de tarjeta guardada Openpay Sandbox.
- /pay/app/receipts: listado de los mismos pagos/cobros confirmados.
- /pay/app/receipt/:requestId: comprobante con referencia de solicitud, identificador de Openpay, importe, moneda y fecha.
- /pay/app/api/statement: consulta JSON autenticada y filtrada por usuario.

## Conexión al Happy Path
El servicio F04 ejecuta un POST de cargo, consulta al proveedor y solo al confirmar estado completed
escribe una referencia del pago en data/waba-statements.json. Luego marca la solicitud PAID y
notifica a cobrador y pagador vinculado, salvo que éste haya desactivado avisos.
Si no puede persistirse el comprobante, el cargo queda UNKNOWN_SAVED_CARD y no se reintenta.

## Límites explícitos
- Solo Openpay Sandbox de tarjetas guardadas del workflow F04; no importa movimientos de Telegram.
- El histórico F00 /pay/charge NO se incorpora automáticamente al estado de cuenta. No se modifica
  esa ruta ni se inventa un recibo financiero para cargo legacy sin identidad comprobada.
- No es estado de cuenta bancario ni saldo disponible.
- El archivo data/waba-statements.json es persistente para el proceso único Node; no comparte
  datos con los repositorios de Telegram ni con otros procesos independientes.
- Sin cambios a Caddy, VPN, Meta, .env, puertos, main, checkout legacy ni deploy.
- CI utiliza solo cuentas y cargos simulados, sin llamar a Openpay ni enviar WhatsApp.

## Verificación
npm install --ignore-scripts --no-audit --no-fund
node --test tests/*.test.js
