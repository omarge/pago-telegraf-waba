# WABA F01 — navegación y microaplicaciones

Entrega incremental: menú interactivo WhatsApp y páginas informativas en /pay/app.
- Comandos: menu, menú, ayuda, inicio, /menu.
- Lista WhatsApp: Cobrar, Pagar, Mis tarjetas, Guardar tarjeta, Mi NIP, Estado de cuenta, Configuración, Comprobantes.
- «Cobrar» continúa en el flujo existente de importe en centavos, enlace y Openpay Sandbox sin cambios.
- Las microaplicaciones son **solo navegación**. No muestran tarjetas, NIP, saldos, movimientos ni ejecutan cargos.
- Próximas fases: identidad autenticada, enrolamiento, tarjetas guardadas/NIP, pagos, movimientos y comprobantes.
- Pruebas exclusivamente offline en GitHub Actions; sin credenciales ni proveedores.
- No modificar deploy, Caddy, VPN, Meta, .env, puertos o ramas de otros repositorios.
- No hacer merge a main ni desplegar sin la revisión del operador.
