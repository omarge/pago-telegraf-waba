'use strict';
// Optional authenticated WABA UI boundary for the BusinessOS R1 adapter.
// Never mounted by default. Requires a server-bound payer and trusted service
// authority resolver; not a standalone PSP payment path.
const express=require('express');
const ORDER=/^KPR-[A-F0-9]{32}$/;
function esc(v){
 return String(v??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&#39;'
 })[c]);
}
function document(body){
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta name="referrer" content="no-referrer">'+
 '<title>KashBitPay · BusinessOS</title></head><body><main>'+
 body+'</main></body></html>';
}
function displayAmount(cents){
 if(!Number.isSafeInteger(cents)||cents<=0)return null;
 return Math.floor(cents/100)+'.'+String(cents%100).padStart(2,'0');
}
function createBusinessosWebRoutes({flow,requestStore,accounts}={}){
 if(!flow||typeof flow.authorize!=='function'||
    !requestStore||typeof requestStore.getRequest!=='function'||
    !accounts||typeof accounts.validCsrf!=='function')
  throw Error('BUSINESSOS_WEB_DEPENDENCY_MISSING');
 const router=express.Router();
 function bound(req){
  if(!ORDER.test(req.params.requestId||'')||!req.account?.accountId)return null;
  const r=requestStore.getRequest(req.params.requestId);
  if(!r||r.id!==req.params.requestId||
     r.payerAccountId!==req.account.accountId)return null;
  return r;
 }
 router.get('/businessos/authorize/:requestId',(req,res)=>{
  res.set('Cache-Control','no-store');
  const r=bound(req);
  if(!r)return res.sendStatus(404);
  const amount=displayAmount(r.amount);
  if(!amount)return res.sendStatus(409);
  if(r.state!=='PENDING')
   return res.status(409).type('html').send(document('<h1>Solicitud no disponible</h1>'));
  return res.type('html').send(document(
   '<h1>Solicitar autorización BusinessOS</h1>'+
   '<p>Solicitud: '+esc(r.id)+'</p>'+
   '<p>Importe: $'+amount+' MXN</p>'+
   '<p>La autorización no confirma la captura ni el pago.</p>'+
   '<form method="post" action="/pay/app/businessos/authorize/'+esc(r.id)+'">'+
   '<input type="hidden" name="_csrf" value="'+esc(req.account.csrf)+'">'+
   '<label><input type="checkbox" name="consent" value="yes" required>'+
   'Solicito autorizar este importe.</label><button type="submit">Autorizar</button>'+
   '</form>'));
 });
 router.post('/businessos/authorize/:requestId',async(req,res)=>{
  res.set('Cache-Control','no-store');
  // Check CSRF and consent first. Never trust tenant, fraud, customer,
  // PSP or bearer fields received in a browser request.
  if(!accounts.validCsrf(req.sessionToken,req.body?._csrf)||
     req.body?.consent!=='yes')return res.sendStatus(403);
  if(!bound(req))return res.sendStatus(404);
  let result;
  try{
   result=await flow.authorize({
    accountId:req.account.accountId,requestId:req.params.requestId,
    csrfVerified:true,consent:true
   });
  }catch(_err){result={state:'UNKNOWN_NO_RETRY'};}
  const state=result?.state;
  const messages={
   AUTHORIZED_PENDING_CAPTURE:['Autorización recibida. Pago no confirmado.',202],
   UNKNOWN_NO_RETRY:['Resultado indeterminado. No repitas la operación.',202],
   DECLINED:['Autorización rechazada.',422],
   IDEMPOTENCY_CONFLICT:['Conflicto de solicitud. No repitas la operación.',409],
   PRE_EXECUTION_FAILED:['Solicitud no autorizada.',422],
   NOT_PENDING:['Solicitud ya procesada o pendiente.',409],
   REQUEST_CHANGED_NO_EXECUTION:['Solicitud modificada; no se autorizó.',409],
   INVALID_TRUSTED_MAPPING:['Identidad o autorización BusinessOS no disponible.',503],
   DENIED_SERVICE_AUTH:['Autorización del servicio no disponible.',503],
   DENIED_BY_BUSINESSOS:['Autorización denegada.',403],
   DISABLED:['Integración desactivada.',503],
   NOT_FOUND:['Solicitud no encontrada.',404]
  };
  const [message,status]=messages[state]||messages.UNKNOWN_NO_RETRY;
  return res.status(status).type('html').send(document(
   '<h1>'+esc(message)+'</h1>'+
   '<p>El canal no confirma captura ni pago.</p>'+
   '<a href="/pay/app">Volver al menú</a>'));
 });
 return router;
}
module.exports={createBusinessosWebRoutes};
