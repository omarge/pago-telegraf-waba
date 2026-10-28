'use strict';
// Not wired into src/index.js, no public port. Use only with injected ledger
// and local 127.0.0.1 test server until explicit live integration approval.
const express=require('express');
function createIsolatedStatusApp({ledger}={}){
 if(!ledger||typeof ledger.ingestSignedStatus!=='function')
  throw Error('F06_INGRESS_CONFIG');
 const app=express();
 app.disable('x-powered-by');
 app.post('/f06/status',express.raw({type:'application/json',limit:'64kb'}),(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!Buffer.isBuffer(req.body))return res.sendStatus(415);
  try{
   const updated=ledger.ingestSignedStatus({
    rawBody:req.body,signature:req.get('x-hub-signature-256')
   });
   return res.status(200).json({ok:true,updates:updated.updated});
  }catch(error){
   if(error?.message==='F06_WEBHOOK_UNVERIFIED')return res.sendStatus(403);
   if(error?.message==='F06_WEBHOOK_INVALID_BODY'||
      error?.message==='F06_WEBHOOK_INVALID_JSON'||
      error?.message==='F06_WEBHOOK_INVALID_ENVELOPE')return res.sendStatus(400);
   return res.sendStatus(503);
  }
 });
 app.use((err,_req,res,_next)=>{
  if(err?.type==='entity.too.large')return res.sendStatus(413);
  return res.sendStatus(400);
 });
 return app;
}
module.exports={createIsolatedStatusApp};
