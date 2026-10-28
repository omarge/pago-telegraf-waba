'use strict';
const express=require('express');
const {statementJournal}=require('./statementJournal');
function esc(v){
 return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function money(minor){return '$'+(minor/100).toFixed(2)+' MXN';}
function layout(title,body){
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta name="referrer" content="no-referrer"><title>'+esc(title)+' · KashBitPay</title>'+
 '<style>body{font:16px system-ui;background:#f1f6f7;color:#173543;padding:16px}'+
 'main{max-width:500px;margin:auto;background:#fff;padding:23px;border-radius:14px}'+
 'p{line-height:1.55}li{padding:14px 0;border-bottom:1px solid #ddd;list-style:none}ul{padding:0}'+
 'input,button{font:inherit;box-sizing:border-box;padding:12px;width:100%;margin:8px 0}'+
 'button{background:#146970;color:#fff;border:0;border-radius:8px}'+
 'a{color:#146970;display:block;margin-top:14px}label{display:block;margin-top:14px}'+
 '.note{background:#edf5f5;border-radius:9px;padding:12px}</style></head><body><main>'+
 body+'</main></body></html>';
}
function formatRecord(record){
 const direction=record.direction==='PAGO'?'Pago':'Cobro';
 return '<li><strong>'+direction+' · '+money(record.amountCents)+'</strong>'+
  '<p>Estado: completado · '+esc(new Date(record.completedAt).toISOString().slice(0,10))+'</p>'+
  '<a href="/pay/app/receipt/'+esc(record.requestId)+'">Ver comprobante</a></li>';
}
function listPage(title,records){
 return layout(title,'<h1>'+title+'</h1>'+
 '<p>Solo cargos Openpay Sandbox de tarjeta guardada, confirmados por el proveedor y asociados a esta cuenta. No es un saldo bancario.</p>'+
 (records.length?'<ul>'+records.map(formatRecord).join('')+'</ul>':
 '<p class="note">Aún no hay pagos o cobros completados registrados para tu cuenta.</p>')+
 '<a href="/pay/app">← Menú</a>');
}
function receiptPage(record){
 return layout('Comprobante','<h1>✅ Comprobante de pago</h1>'+
 '<p>'+esc(record.direction==='PAGO'?'Pago realizado':'Cobro recibido')+'</p>'+
 '<h2>'+money(record.amountCents)+'</h2>'+
 '<p>Estado: <strong>completado</strong></p>'+
 '<p>Solicitud: <code>'+esc(record.requestId)+'</code></p>'+
 '<p>Rastreo Openpay: <code>'+esc(record.chargeId)+'</code></p>'+
 '<p>Fecha: '+esc(new Date(record.completedAt).toISOString())+'</p>'+
 '<p class="note">Openpay Sandbox · El comprobante refleja la confirmación del proveedor, no la entrega del mensaje WhatsApp.</p>'+
 '<a href="/pay/app/statement">← Estado de cuenta</a>');
}
function settingsPage(preferences,csrf,message=''){
 const checked=preferences.whatsappReceipts?' checked':'';
 return layout('Configuración','<h1>Configuración</h1>'+
 '<p>Preferencias de esta cuenta KashBitPay WABA.</p>'+
 (message?'<p class="note">'+esc(message)+'</p>':'')+
 '<form method="post" action="/pay/app/settings">'+
 '<input type="hidden" name="_csrf" value="'+esc(csrf)+'">'+
 '<label>Nombre para mostrar<input name="alias" maxlength="60" value="'+esc(preferences.alias)+'"></label>'+
 '<label><input type="checkbox" name="whatsappReceipts" value="yes" style="width:auto"'+checked+
 '> Recibir comprobantes por WhatsApp cuando haya un pago confirmado</label>'+
 '<button type="submit">Guardar configuración</button></form>'+
 '<a href="/pay/app">← Menú</a>');
}
function createStatementRoutes({accounts,journal=statementJournal}={}){
 if(!accounts||!journal)throw Error('Account and journal required');
 const router=express.Router();
 function records(req){return journal.listForAccount(req.account.accountId,accounts);}
 router.get('/statement',(req,res)=>res.type('html').send(listPage('Estado de cuenta',records(req))));
 router.get('/receipts',(req,res)=>res.type('html').send(listPage('Comprobantes',records(req))));
 router.get('/receipt/:requestId',(req,res)=>{
  const record=journal.receiptForAccount(req.account.accountId,req.params.requestId,accounts);
  if(!record)return res.sendStatus(404);
  return res.type('html').send(receiptPage(record));
 });
 router.get('/api/statement',(req,res)=>res.json({currency:'MXN',movements:records(req)}));
 router.get('/settings',(req,res)=>res.type('html').send(
  settingsPage(accounts.getPreferences(req.account.accountId),req.account.csrf,
   req.query.updated==='1'?'Configuración guardada.':'')));
 router.post('/settings',(req,res)=>{
  if(!accounts.validCsrf(req.sessionToken,req.body?._csrf))return res.sendStatus(403);
  try{
   accounts.setPreferences(req.account.accountId,{
    alias:req.body?.alias,
    whatsappReceipts:req.body?.whatsappReceipts==='yes'
   });
   return res.redirect(303,'/pay/app/settings?updated=1');
  }catch(_error){
   return res.status(400).type('html').send(settingsPage(
    accounts.getPreferences(req.account.accountId),req.account.csrf,'No se pudo guardar la configuración.'));
  }
 });
 return router;
}
module.exports={createStatementRoutes,listPage,receiptPage,settingsPage};
