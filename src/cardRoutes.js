'use strict';
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const {createVault}=require('./cardVault');
const {createSandboxProvider}=require('./openpayCardProvider');
const defaultVault=createVault({provider:createSandboxProvider()});
const enrollJs=fs.readFileSync(path.join(__dirname,'enrollClient.js'),'utf8');
const F03_STAGES=new Set(['CREATE_CUSTOMER','STORE_CUSTOMER','CREATE_CARD','GET_CARD','VERIFY_CARD','STORE_CARD']);
function safeStatus(error){return Number.isInteger(error?.openpayHttpStatus)&&error.openpayHttpStatus>=400&&error.openpayHttpStatus<=599?error.openpayHttpStatus:null;}
function safeCode(error){return /^[0-9]{3,6}$/.test(String(error?.openpayCode??''))?String(error.openpayCode):null;}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function page(title,body,attrs=''){
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">'+
 '<title>'+escapeHtml(title)+' · KashBitPay</title><style>'+
 'body{font:16px system-ui;background:#f2f6f7;color:#173543;padding:20px}'+
 'main{max-width:480px;margin:auto;padding:24px;border-radius:14px;background:#fff}'+
 'input,button{box-sizing:border-box;width:100%;padding:12px;margin:7px 0;font:inherit}'+
 'button{background:#126b70;color:#fff;border:0;border-radius:7px}button:disabled{opacity:.5}'+
 'label{display:block;margin-top:8px}a{display:block;color:#126b70;margin-top:16px}'+
 'p{line-height:1.55}.note{background:#edf5f5;padding:13px;border-radius:8px}'+
 'li{list-style:none;margin-top:8px;padding:12px;border:1px solid #ddd;border-radius:7px}'+
 '</style></head><body><main '+attrs+'>'+body+'</main></body></html>';
}
function cardPage(state){
 const cards=state.cards.map(c=>'<li>'+escapeHtml(c.brand)+' •••• '+escapeHtml(c.last4)+'</li>').join('');
 return page('Mis tarjetas','<h1>Mis tarjetas</h1><p>Tarjetas de prueba vinculadas a esta cuenta WABA.</p>'+
  (cards?'<ul>'+cards+'</ul>':'<p class="note">No tienes tarjetas guardadas.</p>')+
  '<a href="/pay/app/enroll">Guardar tarjeta</a><a href="/pay/app">← Menú</a>');
}
function pinPage(state,csrf,message=''){
 const reset=state.pinConfigured,title=reset?'Cambiar NIP':'Crear NIP';
 let content='<h1>'+title+' KashBitPay</h1><p>El NIP de aplicación tiene cuatro dígitos y no es tu NIP bancario.</p>';
 if(message)content+='<p class="note">'+escapeHtml(message)+'</p>';
 if(!state.pinEnabled)content+='<p class="note">El NIP no está habilitado en este entorno. No lo envíes por WhatsApp.</p>';
 else content+='<form method="post" action="/pay/app/pin" autocomplete="off">'+
  '<input type="hidden" name="_csrf" value="'+escapeHtml(csrf)+'">'+
  '<input type="hidden" name="mode" value="'+(reset?'change':'create')+'">'+
  '<label>Contraseña de cuenta<input name="password" type="password" autocomplete="current-password" required></label>'+
  '<label>Nuevo NIP<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" required></label>'+
  '<label>Confirmar NIP<input name="confirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" required></label>'+
  '<button type="submit">'+title+'</button></form>';
 return page('Mi NIP',content+'<a href="/pay/app">← Menú</a>');
}
function enrollPage(state,provider,csrf){
 if(!state.enrollmentEnabled||!provider)return page('Guardar tarjeta',
  '<h1>Guardar tarjeta</h1><p class="note">Enrolamiento Sandbox desactivado. No se solicitan tarjetas.</p>'+
  '<a href="/pay/app/cards">← Mis tarjetas</a>');
 const content='<h1>Guardar tarjeta · Sandbox</h1>'+
 '<p class="note">Usa solo tarjetas de prueba. El número y CVV se envían directamente a Openpay.js.</p>'+
 '<form id="enroll-card" autocomplete="off">'+
 '<label>Nombre<input id="first" required maxlength="80"></label>'+
 '<label>Apellido<input id="last" required maxlength="80"></label>'+
 '<label>Titular<input id="holder" required maxlength="80"></label>'+
 '<label>Tarjeta de prueba<input id="pan" inputmode="numeric" required autocomplete="off"></label>'+
 '<label>Mes<input id="month" inputmode="numeric" required maxlength="2"></label>'+
 '<label>Año<input id="year" inputmode="numeric" required maxlength="2"></label>'+
 '<label>CVV de prueba<input id="cvv" inputmode="numeric" required maxlength="4" autocomplete="off"></label>'+
 '<input id="device-id" type="hidden">'+
 '<label><input id="consent" type="checkbox" style="width:auto" required> Autorizo guardar esta tarjeta de prueba.</label>'+
 '<button id="submit" disabled>Guardar tarjeta</button></form>'+
 '<p role="status" id="status">Iniciando Openpay…</p>'+
 '<a href="/pay/app/cards">← Mis tarjetas</a>'+
 '<script src="https://js.openpay.mx/openpay.v1.min.js"></script>'+
 '<script src="https://js.openpay.mx/openpay-data.v1.min.js"></script>'+
 '<script src="/pay/app/assets/enroll.js"></script>';
 const attrs='data-merchant="'+escapeHtml(provider.merchantId)+'" data-public-key="'+
  escapeHtml(provider.publicKey)+'" data-csrf="'+escapeHtml(csrf)+'"';
 return page('Guardar tarjeta',content,attrs);
}
function createCardRoutes({accounts,vault=defaultVault,logger=console}={}){
 if(!accounts||typeof accounts.validCsrf!=='function')throw Error('Account service required');
 const api=express.Router();
 api.use(express.json({limit:'8kb'}));
 api.get('/',(req,res)=>res.json(vault.profile(req.account.accountId)));
 api.post('/enroll',async(req,res)=>{
  if(!accounts.validCsrf(req.sessionToken,req.get('X-CSRF-Token')))return res.sendStatus(403);
  try{
   const input=req.body||{};
   const card=await vault.enroll(req.account.accountId,{
    tokenId:input.tokenId,deviceSessionId:input.deviceSessionId,
    firstName:input.firstName,lastName:input.lastName,email:req.account.email,
    consent:input.consent
   });
   return res.status(201).json(card);
  }catch(error){
   // Diagnostics are deliberately restricted to an internal stage and numeric codes.
   // Do not log raw Openpay responses, request body, token, device session or customer/card IDs.
   const stage=F03_STAGES.has(error?.enrollmentStage)?error.enrollmentStage:'VALIDATION';
   const openpayHttpStatus=safeStatus(error),openpayCode=safeCode(error);
   logger.warn('[f03-enroll]',{stage,openpayHttpStatus,openpayCode});
   return res.status(vault.profile(req.account.accountId).enrollmentEnabled?409:503)
    .json({error:'Registro de tarjeta no confirmado. Consulta las tarjetas antes de reintentar.',
     stage,openpayHttpStatus,openpayCode});
  }
 });
 return {
  api,
  vault,
  enrollScript:(_req,res)=>res.type('application/javascript').send(enrollJs),
  cards:(req,res)=>res.type('html').send(cardPage(vault.profile(req.account.accountId))),
  enroll:(req,res)=>res.type('html').send(enrollPage(vault.profile(req.account.accountId),vault.provider,req.account.csrf)),
  pinGet:(req,res)=>res.type('html').send(pinPage(vault.profile(req.account.accountId),req.account.csrf,
   req.query.updated==='1'?'NIP actualizado.':'')),
  pinPost:(req,res)=>{
   if(!accounts.validCsrf(req.sessionToken,req.body?._csrf))return res.sendStatus(403);
   const {password,pin,confirmation,mode}=req.body||{};
   if(pin!==confirmation)return res.status(400).type('html').send(
    pinPage(vault.profile(req.account.accountId),req.account.csrf,'Los NIP no coinciden.'));
   try{
    vault.setPin(req.account.accountId,pin,password,
     (accountId,secret)=>accounts.verifyPassword(accountId,secret),{reset:mode==='change'});
    return res.redirect(303,'/pay/app/pin?updated=1');
   }catch(_e){
    return res.status(400).type('html').send(pinPage(vault.profile(req.account.accountId),
     req.account.csrf,'No se pudo guardar el NIP. Revisa contraseña y datos.'));
   }
  }
 };
}
module.exports={createCardRoutes,cardPage,pinPage,enrollPage};
