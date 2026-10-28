'use strict';
// Optional claim-only route. Never mounts by default; it neither charges nor
// issues a bearer/claim token. One-time secret is entered via POST.
const express=require('express');
const ORDER=/^KPR-[A-F0-9]{32}$/;
function escapeHtml(s){
 return String(s??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;',"'":'&#39;'
 })[c]);
}
function createBusinessosClaimRoutes({claims,accounts}={}){
 if(!claims||typeof claims.claim!=='function'||
    !accounts||typeof accounts.validCsrf!=='function')
  throw Error('R3_CLAIM_ROUTE_DEPENDENCIES');
 const router=express.Router();
 router.get('/businessos/claim/:requestId',(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!ORDER.test(req.params.requestId))return res.sendStatus(404);
  if(!req.account?.whatsappLinked)return res.sendStatus(403);
  return res.type('html').send(
   '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
   '<meta name="referrer" content="no-referrer"></head><body>'+
   '<h1>Vincular una solicitud a esta cuenta</h1>'+
   '<p>Esta vinculación no autoriza ni realiza un pago.</p>'+
   '<form method="post" action="/pay/app/businessos/claim/'+escapeHtml(req.params.requestId)+'">'+
   '<input type="hidden" name="_csrf" value="'+escapeHtml(req.account.csrf)+'">'+
   '<label>Código de la solicitud<input type="password" name="claimSecret" '+
   'autocomplete="off" required></label>'+
   '<label><input type="checkbox" name="consent" value="yes" required>'+
   'Vincular esta solicitud a mi cuenta.</label>'+
   '<button type="submit">Vincular</button></form></body></html>');
 });
 router.post('/businessos/claim/:requestId',(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!accounts.validCsrf(req.sessionToken,req.body?._csrf)||
     req.body?.consent!=='yes')return res.sendStatus(403);
  let outcome;
  try{outcome=claims.claim({
   requestId:req.params.requestId,claimSecret:req.body?.claimSecret,
   accountId:req.account.accountId,
   csrfVerified:true,whatsappLinked:req.account.whatsappLinked===true
  });}catch(_e){return res.sendStatus(503);}
  if(outcome.state==='CLAIMED')
   return res.status(200).type('html').send('<h1>Solicitud vinculada. Pago no realizado.</h1>');
  if(outcome.state==='ALREADY_CLAIMED')return res.sendStatus(409);
  if(outcome.state==='EXPIRED')return res.sendStatus(410);
  if(outcome.state==='REQUEST_CHANGED')return res.sendStatus(409);
  if(outcome.state==='DENIED')return res.sendStatus(403);
  return res.sendStatus(404);
 });
 return router;
}
module.exports={createBusinessosClaimRoutes};
