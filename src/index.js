require('dotenv').config();
const express = require('express');
const { handleWebhook } = require('./webhook');
const { startFormServer } = require('./formServer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WABA_VERIFY_TOKEN || 'kashbit_verify';

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    await handleWebhook(req.body);
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`WABA webhook listening on ${PORT}`);
});

const FORM_PORT = process.env.FORM_PORT || 8765;
startFormServer(FORM_PORT);
