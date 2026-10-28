const express = require('express');
const https = require('https');
const store = require('./store');
const { sendMessage } = require('./waba');
const { createAccountRouter } = require('./accountRoutes');

const MERCHANT = process.env.OPENPAY_MERCHANT_ID || '';
const PRIVATE_KEY = process.env.OPENPAY_PRIVATE_KEY || '';
const PUBLIC_KEY = process.env.OPENPAY_PUBLIC_KEY || '';

function createFormApp({paymentStore=store,accountRouter=createAccountRouter(),
  messenger={sendMessage},charge=openpayCharge,merchant=MERCHANT,privateKey=PRIVATE_KEY,
  legacyChargeEnabled=false,
  showSavedCardOption=process.env.WABA_SAVED_CARD_PAY_SANDBOX === '1' &&
    process.env.WABA_CARD_ENROLL_SANDBOX === '1'}={}) {
  const app = express();
  app.use(express.json());

  // Account microapps remain separate from existing financial endpoints.
  app.use('/pay/app', accountRouter);

  app.get('/pay/request/:token', (req, res) => {
    const inv = paymentStore.consumeInvite(req.params.token);
    if (!inv) {
      return res.status(404).send('Enlace inválido o expirado.');
    }
    const payment = paymentStore.createRequest(inv.requesterId, 'waba-payer', inv.amount);
    const amountText = (inv.amount / 100).toFixed(2);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paymentPage(payment.id, inv.amount, amountText, inv.requesterId, showSavedCardOption, legacyChargeEnabled));
  });

  app.post('/pay/charge', async (req, res) => {
    // UAT safety: legacy token flow accepts caller-provided amount and recipient.
    // Do not expose it in a public/default app. Explicit enable is test-only.
    if (legacyChargeEnabled !== true) return res.sendStatus(404);
    const { token_id, amount = 1000, holder, request_id, requester_id } = req.body || {};
    console.log('[charge] token_id=', token_id, 'rid=', request_id);
    if (!token_id || !merchant || !privateKey) {
      return res.status(400).json({ error: 'missing token or openpay config' });
    }
    try {
      const result = await charge(token_id, amount, holder);
      console.log('[charge] openpay result', result.id, result.status);
      if (request_id && requester_id) {
        const amountText = (amount / 100).toFixed(2);
        const msg = `✅ Pago completado\nSolicitud: ${request_id}\nImporte: $${amountText} MXN\nRastreo: ${result.id}`;
        try { await messenger.sendMessage(requester_id, msg); } catch (_) {}
      }
      res.json({ ok: true, charge_id: result.id, status: result.status });
    } catch (e) {
      console.error('[charge] error', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  app.get('/healthz', (_req, res) => res.send('ok'));

  return app;
}

function startFormServer(port = 8765) {
  const app = createFormApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Form server on ${port}`);
  });
}

function openpayCharge(tokenId, amountCents, holder) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      source_id: tokenId,
      method: 'card',
      amount: amountCents / 100,
      currency: 'MXN',
      description: 'KashBitPay WABA',
      device_session_id: 'kashbit-waba',
      customer: {
        name: (holder || 'Cliente').split(' ')[0] || 'Cliente',
        last_name: (holder || 'Prueba').split(' ').slice(1).join(' ') || 'Prueba',
        email: 'test@kashbit.bond',
        phone_number: '5555555555',
      },
    });
    const auth = Buffer.from(PRIVATE_KEY + ':').toString('base64');
    const opts = {
      hostname: 'sandbox-api.openpay.mx',
      path: `/v1/${MERCHANT}/charges`,
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (r.statusCode >= 200 && r.statusCode < 300) resolve(j);
          else reject(new Error(j.description || j.error_code || 'openpay ' + r.statusCode));
        } catch (e) {
          reject(new Error('bad response'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function paymentPage(requestId, amountCents, amountText, requesterId,
  showSavedCardOption = process.env.WABA_SAVED_CARD_PAY_SANDBOX === '1' &&
    process.env.WABA_CARD_ENROLL_SANDBOX === '1', legacyChargeEnabled=false) {
  // The normal UAT page must never offer a new-card form that submits to a
  // disabled or unbound legacy charge endpoint. Saved-card route stays intact.
  if (legacyChargeEnabled !== true) {
    const link=showSavedCardOption?
      '<a href="/pay/app/pay/'+requestId+'">Pagar con tarjeta guardada</a>':
      '<p>Pago con tarjeta guardada no habilitado en este entorno.</p>';
    return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
      '<meta name="viewport" content="width=device-width,initial-scale=1">'+
      '<meta name="referrer" content="no-referrer"><title>KashBitPay Sandbox</title>'+
      '</head><body><main><h1>Solicitud de pago</h1>'+
      '<p>Importe: '+String.fromCharCode(36)+amountText+' MXN</p>'+
      '<p>Solicitud: '+requestId+'</p>'+link+'</main></body></html>';
  }
  const pk = PUBLIC_KEY || 'pk_test_placeholder';
  const mid = MERCHANT || 'merchant_placeholder';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago KashBitPay</title>
<script src="https://js.openpay.mx/openpay.v1.min.js"></script>
<script src="https://js.openpay.mx/openpay-data.v1.min.js"></script>
<style>
body{font:16px system-ui;background:#f3f5f8;padding:16px;color:#183044}
main{max-width:450px;margin:auto;background:white;padding:24px;border-radius:14px}
label{display:block;margin-top:14px}input{box-sizing:border-box;width:100%;padding:12px}
button{margin-top:20px;padding:14px;width:100%;border:0;border-radius:8px;background:#126b70;color:white}
#status{white-space:pre-wrap;margin-top:12px}
</style></head><body><main data-mid="${mid}" data-pk="${pk}">
<h2>Pago KashBitPay</h2>
<p>Importe: <strong>$${amountText} MXN</strong></p>
<p>Solicitud: <code>${requestId}</code></p>
${showSavedCardOption ? '<p><a href="/pay/app/pay/' + requestId + '">Pagar con tarjeta guardada</a></p>' : ''}
<p id="status">Cargando…</p>
<form id="payment" autocomplete="off">
<label>Titular<input id="holder" required maxlength="80"></label>
<label>Número de tarjeta<input id="pan" required inputmode="numeric"></label>
<label>Mes<input id="month" required inputmode="numeric" placeholder="MM" maxlength="2"></label>
<label>Año<input id="year" required inputmode="numeric" placeholder="AA" maxlength="2"></label>
<label>CVV<input id="cvv" required inputmode="numeric" maxlength="4"></label>
<button type="submit">Pagar</button>
</form>
<script>
const status = document.getElementById('status');
const form = document.getElementById('payment');
const root = document.querySelector('main');
function say(m){ status.textContent = m; console.log('[form]', m); }
if (window.OpenPay) {
  OpenPay.setId(root.dataset.mid);
  OpenPay.setApiKey(root.dataset.pk);
  OpenPay.setSandboxMode(true);
  say('Listo. Captura la tarjeta.');
} else { say('Openpay.js no cargó.'); }
form.addEventListener('submit', (e) => {
  e.preventDefault();
  say('Tokenizando…');
  const holder = document.getElementById('holder').value;
  const pan = document.getElementById('pan').value;
  const details = {
    holder_name: holder,
    card_number: pan,
    expiration_month: document.getElementById('month').value,
    expiration_year: document.getElementById('year').value,
    cvv2: document.getElementById('cvv').value
  };
  document.getElementById('pan').value = '';
  document.getElementById('cvv').value = '';
  OpenPay.token.create(details, async (resp) => {
    const tokenId = resp && resp.data && resp.data.id;
    if (!tokenId) { say('Openpay no devolvió token'); return; }
    say('Cobrando…');
    try {
      const r = await fetch('/pay/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId, amount: ${amountCents}, holder, request_id: '${requestId}', requester_id: '${requesterId}' })
      });
      const j = await r.json();
      if (j.ok) {
        say('✅ Pago completado. Rastreo: ' + j.charge_id);
      } else say('Error: ' + (j.error || r.status));
    } catch (err) { say('Error: ' + err.message); }
  }, (err) => {
    say('Tokenización rechazada');
  });
});
</script></main></body></html>`;
}

module.exports = { startFormServer, createFormApp };
