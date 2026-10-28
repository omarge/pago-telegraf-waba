# KashBitPay WhatsApp Bot

Bot de pagos para WhatsApp Business API.

## Setup

```bash
cp .env.example .env
# Edita .env con tus credenciales de WABA y Openpay
npm install
npm start
```

## Webhook

Configura el webhook en Meta Business:
- URL: `https://tu-dominio/webhook`
- Verify token: el valor de `WABA_VERIFY_TOKEN`

## Flujo

1. Cobrador escribe "cobrar" al número de WhatsApp
2. Bot pide el monto
3. Bot genera un enlace de pago
4. Cobrador envía el enlace al pagador
5. Pagador abre el enlace y paga

## Notas

- Separado del bot de Telegram (`pago-telegra-telegraf`)
- Los formularios de pago se abren en el navegador (no hay Mini Apps en WhatsApp)
- Requiere webhook HTTPS (no polling)
