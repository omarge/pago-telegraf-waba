'use strict';
// Opt-in R11 financial handoff UI; never mount without a trusted session,
// payer-bound Postgres read, CSRF and affirmative consent.
// This module cannot execute Payment independently: flow is injected.
const express=require('express');
const ORDER=/^KPR-[A-F0-9]{32}$/;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({
 '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;',"'":'&#39;'
})[c]);
const page=s=>'<html lang="es"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body>'+s+'</body></html>';
function createR11AuthenticatedRoutes({flow,requestStore,accounts}={}){
 if(flow?.isEnabled!==true||typeof flow.authorizeOnce!=='function'||
    typeof requestStore?.getRequest!=='function'||
    typeof accounts?.validCsrf!=='function')
  throw Error('R11_AUTHENTICATED_ROUTE_DEPENDENCIES_REQUIRED');
 const router=express.Router();
 async function bound(req){
  const id=req.params.requestId,account=req.account;
  if(!ORDER.test(id||'')||!account||typeof account.accountId!=='string'||
     typeof req.sessionToken!=='string')return null;
  let r;
  try{r=await requestStore.getRequest(id);}catch(_e){return null;}
  if(!r||r.id!==id||r.payerAccountId!==account.accountId||
     r.state!=='PENDING'||!Number.isSafeInteger(r.amount)||r.amount<=0)
   return null;
  return r;
 }
 router.get('/businessos/r11/authorize/:requestId',async(req,res)=>{
  res.set('Cache-Control','no-store');
  const r=await bound(req);
  if(!r)return res.sendStatus(404);
  const amount=Math.floor(r.amount/100)+'.'+String(r.amount%100).padStart(2,'0');
  return res.status(200).type('html').send(page(
   '<h1>Autorizar con BusinessOS</h1><p>Solicitud: '+esc(r.id)+'</p>'+
   '<p>Importe: $'+amount+' MXN</p>'+
   '<p>Autorización no equivale a pago completado.</p>'+
   '<form method="post" action="/pay/app/businessos/r11/authorize/'+esc(r.id)+'">'+
   '<input type="hidden" name="_csrf" value="'+esc(req.account.csrf)+'">'+
   '<label><input type="checkbox" name="consent" value="yes" required>Autorizo solicitar este importe</label>'+
   '<button type="submit">Solicitar autorización</button></form>'
  ));
 });
 router.post('/businessos/r11/authorize/:requestId',async(req,res)=>{
  res.set('Cache-Control','no-store');
  // Session account and token are injected only by accountRoutes.requireSession.
  // No tenant, method, bearer, Fraud or economic fields are read from req.body.
  if(!req.account?.accountId||!req.sessionToken||
     !accounts.validCsrf(req.sessionToken,req.body?._csrf)||
     req.body?.consent!=='yes')return res.sendStatus(403);
  const r=await bound(req);
  if(!r)return res.sendStatus(404);
  let result;
  try{
   result=await flow.authorizeOnce({
    requestId:r.id,accountId:req.account.accountId,csrfVerified:true,consent:true
   });
  }catch(_e){result={state:'UNKNOWN_HOLD_NO_AUTO_RETRY'};}
  const status=result?.state;
  // Financially ambiguous responses must never be announced as paid.
  const outcomes={
   AUTHORIZED_PENDING_CAPTURE_NOT_PAID:[202,'Autorización pendiente de captura. Pago no confirmado.'],
   UNKNOWN_HOLD_NO_AUTO_RETRY:[202,'Estado indeterminado. No repitas la operación.'],
   HOLD_NO_AUTO_RETRY:[202,'Operación reservada. No repitas la operación.'],
   DECLINED:[422,'Autorización rechazada.'],
   PRE_EXECUTION_FAILED:[422,'Autorización no ejecutada.'],
   DENIED:[403,'Autorización denegada.'],
   REQUEST_CHANGED_NO_EFFECT:[409,'Solicitud modificada.'],
   DISABLED:[503,'Integración no disponible.']
  };
  const [code,message]=outcomes[status]||outcomes.UNKNOWN_HOLD_NO_AUTO_RETRY;
  return res.status(code).type('html').send(page(
   '<h1>'+esc(message)+'</h1><p>El canal no certifica un pago completado.</p>'+
   '<a href="/pay/app">Regresar</a>'
  ));
 });
 return router;
}
module.exports={createR11AuthenticatedRoutes};
