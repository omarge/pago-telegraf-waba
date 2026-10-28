require('dotenv').config();
const express = require('express');
const {verifySignature}=require('./f06DeliveryEvidence');
const { handleWebhook } = require('./webhook');
const { startFormServer } = require('./formServer');

const PORT = process.env.PORT || 8766;
const VERIFY_TOKEN = process.env.WABA_VERIFY_TOKEN || 'kashbit_verify';

function createWebhookApp({onWebhook=handleWebhook,verifyToken=VERIFY_TOKEN,
  appSecret=process.env.WABA_APP_SECRET,logger=console}={}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === verifyToken) {
      logger.log('Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  // F09 fail-closed ingress: verify exact original bytes before ACK.
  app.post('/webhook',
    (req,res,next)=>{
      res.set('Cache-Control','no-store');
      if(typeof appSecret!=='string'||appSecret.length<16)
        return res.sendStatus(503);
      if(!req.is('application/json'))return res.sendStatus(415);
      next();
    },
    express.raw({type:'application/json',limit:'64kb',inflate:false}),
    (req,res)=>{
      const bytes=req.body;
      if(!Buffer.isBuffer(bytes)||bytes.length===0)return res.sendStatus(400);
      if(!verifySignature(bytes,req.get('X-Hub-Signature-256'),appSecret))
        return res.sendStatus(403);
      let body;
      try{body=JSON.parse(bytes.toString('utf8'));}
      catch(_error){return res.sendStatus(400);}
      if(body?.object!=='whatsapp_business_account'||!Array.isArray(body.entry))
        return res.sendStatus(400);
      // Still acknowledges before DURABLE processing; not UAT-ready.
      res.sendStatus(200);
      Promise.resolve().then(()=>onWebhook(body)).catch(_error=>{
        logger.error('Webhook dispatch failed after accepted request');
      });
    });
  app.use((err,_req,res,_next)=>{
    if(res.headersSent)return;
    if(err?.type==='entity.too.large')return res.sendStatus(413);
    return res.sendStatus(400);
  });

  app.get('/healthz', (_req, res) => res.send('ok'));
  return app;
}

function startWabaServer() {
  const app = createWebhookApp();
  app.listen(PORT, () => {
    console.log(`WABA webhook listening on ${PORT}`);
  });
  const FORM_PORT = process.env.FORM_PORT || 8765;
  startFormServer(FORM_PORT);
}

if (require.main === module) startWabaServer();

module.exports = {createWebhookApp,startWabaServer};
