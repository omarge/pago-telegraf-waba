const express = require('express');
const store = require('./store');

function startFormServer(port = 8765) {
  const app = express();
  app.use(express.json());

  app.get('/pay/request/:token', (req, res) => {
    const inv = store.consumeInvite(req.params.token);
    if (!inv) {
      return res.status(404).send('Enlace inválido o expirado.');
    }
    const payment = store.createRequest(inv.requesterId, 'waba-payer', inv.amount);
    const amountText = (inv.amount / 100).toFixed(2);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paymentPage(payment.id, amountText));
  });

  app.get('/healthz', (_req, res) => res.send('ok'));

  app.listen(port, '0.0.0.0', () => {
    console.log(`Form server on ${port}`);
  });
}

function paymentPage(requestId, amountText) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago KashBitPay</title>
<style>
body{font:16px system-ui;background:#f3f5f8;padding:16px;color:#183044}
main{max-width:450px;margin:auto;background:white;padding:24px;border-radius:14px}
label{display:block;margin-top:14px}input{box-sizing:border-box;width:100%;padding:12px}
button{margin-top:20px;padding:14px;width:100%;border:0;border-radius:8px;background:#126b70;color:white}
</style></head><body><main>
<h2>Pago KashBitPay</h2>
<p>Importe: <strong>$${amountText} MXN</strong></p>
<p>Solicitud: <code>${requestId}</code></p>
<form id="payment">
<label>Titular<input id="holder" required></label>
<label>Número de tarjeta<input id="pan" required inputmode="numeric"></label>
<label>Mes<input id="month" required maxlength="2" placeholder="MM"></label>
<label>Año<input id="year" required maxlength="2" placeholder="AA"></label>
<label>CVV<input id="cvv" required maxlength="4"></label>
<button type="submit">Pagar</button>
</form>
<p id="status"></p>
<script>
document.getElementById('payment').onsubmit = (e) => {
  e.preventDefault();
  document.getElementById('status').textContent = 'Procesando... (demo)';
};
</script>
</main></body></html>`;
}

module.exports = { startFormServer };
