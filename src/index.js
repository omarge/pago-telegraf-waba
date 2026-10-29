require('dotenv').config();
const express = require('express');
const {verifySignature}=require('./f06DeliveryEvidence');
const { handleWebhook } = require('./webhook');
const { startFormServer } = require('./formServer');
const {createDurableIngress}=require('./businessosDurableIngressBootstrap');

const PORT = process.env.PORT || 8766;
const VERIFY_TOKEN = process.env.WABA_VERIFY_TOKEN || 'kashbit_verify';

function createWebhookApp({onWebhook=handleWebhook,verifyToken=VERIFY_TOKEN,
  appSecret=process.env.WABA_APP_SECRET,logger=console,durableInbox=null}={}) {
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
      // R5 optional durable encrypted inbox. The default server never injects
      // this: existing F09/F07 behavior stays unchanged. When injected, NO
      // webhook side effects occur until a separate authorized worker exists.
      if(durableInbox!==null){
        if(durableInbox?.isDurableSignedInbox!==true||
           typeof durableInbox.persistSignedEnvelope!=='function')
          return res.sendStatus(503);
        Promise.resolve().then(()=>durableInbox.persistSignedEnvelope({
          rawBody:bytes,signature:req.get('X-Hub-Signature-256')
        })).then(outcome=>{
          if(outcome?.state==='STORED'||outcome?.state==='DUPLICATE')
            return res.sendStatus(200);
          if(outcome?.state==='CONFLICT')return res.sendStatus(409);
          if(outcome?.state==='UNVERIFIED')return res.sendStatus(403);
          if(outcome?.state==='INVALID')return res.sendStatus(400);
          return res.sendStatus(503);
        }).catch(()=>res.sendStatus(503));
        return;
      }
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

async function startWabaServer({env=process.env}={}) {
  // Strict mode is opt-in and does not process messages yet. It persists them
  // only; no worker or BusinessOS financial execution is started here.
  const durable=await createDurableIngress({env});
  const app=createWebhookApp({
    durableInbox:durable?.inbox||null,
    appSecret:env.WABA_APP_SECRET,
    verifyToken:env.WABA_VERIFY_TOKEN||'kashbit_verify'
  });
  const port=env.PORT||PORT;
  const listener=app.listen(port,()=>{
    console.log(`WABA webhook listening on ${port}`);
  });
  const formPort=env.FORM_PORT||8765;
  startFormServer(formPort);
  return {listener,durable};
}

if (require.main === module) {
  startWabaServer().catch(()=>{
    console.error('WABA durable ingress startup refused; no webhook listener opened');
    process.exitCode=1;
  });
}

module.exports = {createWebhookApp,startWabaServer};
