const https = require('https');

const TOKEN = process.env.WABA_TOKEN;
const PHONE_ID = process.env.WABA_PHONE_ID;
const TEST_TO = process.env.WABA_TEST_TO || '';

function normalizePhone(to) {
  if (TEST_TO) return TEST_TO;
  if (!to) return to;
  // Mexican numbers: WhatsApp sends 521... but Cloud API often wants 52...
  if (to.startsWith('521') && to.length === 13) {
    return '52' + to.slice(3);
  }
  return to;
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${path}`,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    console.log('[waba] request', method, path, 'to=', body?.to);
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('[waba] response', res.statusCode, d.slice(0, 300));
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', (e) => {
      console.error('[waba] request error:', e.message);
      reject(e);
    });
    req.on('timeout', () => {
      console.error('[waba] request timeout');
      req.destroy();
      reject(new Error('timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function sendMessage(to, text) {
  const original = to;
  to = normalizePhone(to);
  console.log('[waba] sendMessage original=', original, 'normalized=', to);
  return api('POST', `${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

async function sendButtons(to, text, buttons) {
  to = normalizePhone(to);
  return api('POST', `${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

async function sendList(to, text, buttonText, sections) {
  to = normalizePhone(to);
  return api('POST', `${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text },
      action: {
        button: buttonText,
        sections,
      },
    },
  });
}

module.exports = { sendMessage, sendButtons, sendList };
