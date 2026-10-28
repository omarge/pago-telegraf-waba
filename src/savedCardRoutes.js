'use strict';
const express=require('express');
const {createSavedCardFlow}=require('./savedCardFlow');
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function page(body){
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta name="referrer" content="no-referrer"><title>Pago con tarjeta guardada · KashBitPay</title>'+
 '<style>body{font:16px system-ui;background:#f1f6f7;padding:16px;color:#173543}'+
 'main{max-width:470px;margin:auto;background:white;border-radius:14px;padding:24px}'+
 'input,select,button{box-sizing:border-box;font:inherit;padding:12px;width:100%;margin:8px 0}'+
 'button{background:#146970;color:white;border:0;border-radius:7px}button:disabled{opacity:.5}'+
 'label{display:block;margin-top:12px}p{line-height:1.5}a{display:block;color:#146970;margin-top:16px}'+
 '.message{background:#edf5f5;padding:12px;border-radius:8px}</style></head><body><main>'+
 body+'</main></body></html>';
}
function show(view,csrf,merchantId,publicKey){
 if(!view)return page('<h1>Solicitud no encontrada</h1>');
 let content='<h1>Pagar con tarjeta guardada</h1>'+
 '<p>Solicitud: '+esc(view.requestId)+'</p>'+
 '<h2>$'+(view.amountCents/100).toFixed(2)+' MXN</h2>';
 if(view.state==='PAID')return page(content+'<p class="message">✅ Pago completado.</p>');
 if(view.state!=='PENDING')return page(content+'<p class="message">Solicitud procesada o pendiente de revisión.</p>');
 if(!view.enabled)return page(content+'<p class="message">Pago con tarjeta guardada Sandbox no habilitado.</p>');
 if(!view.cards.length)return page(content+'<p class="message">Primero guarda una tarjeta de prueba.</p><a href="/pay/app/enroll">Guardar tarjeta</a>');
 if(!view.pinConfigured)return page(content+'<p class="message">Primero configura tu NIP KashBitPay.</p><a href="/pay/app/pin">Crear NIP</a>');
 const options=view.cards.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.brand)+' •••• '+esc(c.last4)+'</option>').join('');
 content+='<p>Selecciona tu tarjeta, escribe el NIP y confirma el importe.</p>'+
 '<form method="post" id="saved-payment" autocomplete="off" action="/pay/app/pay/'+esc(view.requestId)+'"'+
 ' data-mid="'+esc(merchantId)+'" data-pk="'+esc(publicKey)+'">'+
 '<input type="hidden" name="_csrf" value="'+esc(csrf)+'">'+
 '<label>Tarjeta<select name="cardId" required>'+options+'</select></label>'+
 '<label>NIP KashBitPay<input type="password" name="pin" inputmode="numeric" autocomplete="off" minlength="4" maxlength="4" pattern="[0-9]{4}" required></label>'+
 '<input type="hidden" id="device-id" name="deviceSessionId">'+
 '<label><input type="checkbox" name="consent" value="yes" style="width:auto" required> Autorizo pagar $'+
 (view.amountCents/100).toFixed(2)+' MXN con esta tarjeta.</label>'+
 '<button type="submit" id="confirm" disabled>Confirmar pago $'+(view.amountCents/100).toFixed(2)+'</button></form>'+
 '<p id="device-status" class="message">Preparando Openpay Sandbox…</p>'+
 '<script src="https://js.openpay.mx/openpay.v1.min.js"></script>'+
 '<script src="https://js.openpay.mx/openpay-data.v1.min.js"></script>'+
 '<script src="/pay/app/assets/saved-pay.js"></script>';
 return page(content);
}
function receipt(result,view){
 if(result.state==='PAID')return page('<h1>✅ Pago completado</h1>'+
  '<p>Solicitud: '+esc(view.requestId)+'</p>'+
  '<p>Importe: $'+(result.amountCents/100).toFixed(2)+' MXN</p>'+
  '<p>Rastreo: '+esc(result.chargeId)+'</p>'+
  '<p>Se solicitó la notificación por WhatsApp.</p><a href="/pay/app">Volver al menú</a>');
 if(result.state==='UNKNOWN_SAVED_CARD'||result.state==='SUBMITTING_SAVED_CARD')return page(
  '<h1>Resultado pendiente</h1><p>El cargo puede haberse procesado. No lo repitas; verifica en Openpay Sandbox.</p>'+
  '<p>Solicitud: '+esc(view.requestId)+'</p>');
 return page('<h1>Pago no realizado</h1>'+
  '<p>Estado: '+esc(result.state)+'</p><a href="/pay/app/pay/'+esc(view.requestId)+'">Volver</a>');
}
function createSavedCardRoutes({accounts,vault,requestStore,notifier,journal,enabled=false}={}){
 if(!accounts||!vault||!requestStore)throw Error('Missing payment dependencies');
 const flow=createSavedCardFlow({accounts,vault,requestStore,notify:notifier,journal,enabled});
 const router=express.Router();
 router.get('/assets/saved-pay.js',(_req,res)=>res.type('application/javascript').send(require('node:fs').readFileSync(require('node:path').join(__dirname,'savedPayClient.js'),'utf8')));
 router.get('/pay/:requestId',(req,res)=>{
  const view=flow.view(req.account.accountId,req.params.requestId);
  if(!view)return res.sendStatus(404);
  return res.type('html').send(show(view,req.account.csrf,vault.provider?.merchantId||'',vault.provider?.publicKey||''));
 });
 router.post('/pay/:requestId',async(req,res)=>{
  const view=flow.view(req.account.accountId,req.params.requestId);
  if(!view)return res.sendStatus(404);
  const result=await flow.pay({
   accountId:req.account.accountId,requestId:req.params.requestId,
   cardId:req.body?.cardId,pin:req.body?.pin,
   consent:req.body?.consent==='yes',deviceSessionId:req.body?.deviceSessionId,
   csrfVerified:accounts.validCsrf(req.sessionToken,req.body?._csrf)
  });
  return res.status(result.state==='PAID'?200:result.state==='UNKNOWN_SAVED_CARD'?202:400)
   .type('html').send(receipt(result,view));
 });
 return {router,flow};
}
module.exports={createSavedCardRoutes,show,receipt};
