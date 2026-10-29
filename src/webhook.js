'use strict';
const liveMessenger=require('./waba');
const liveStore=require('./store');
const nav=require('./navigation');
const {accountService}=require('./accountService');
function createWebhook({messenger=liveMessenger,store=liveStore,log=console,baseUrl,accounts=accountService}={}){
 async function handleMessage(msg,contact){
  if(!msg?.from)return;
  const from=msg.from,name=contact?.profile?.name||from;
  log.log('Message from',from,name,'type:',msg.type);
  const text=msg.type==='text'?String(msg.text?.body||'').trim().toLowerCase():'';
  // Bind messages must not be written into message logs.
  if(msg.type==='text' && /^vincular(?:\s|$)/i.test(text)){
   const code=text.slice('vincular'.length).trim().toUpperCase();
   let linked=false;
   try{linked=accounts.bindFromWhatsApp(from,code);}
   catch(_e){log.error('WhatsApp account linking failed');}
   await messenger.sendMessage(from,linked?
    '✅ Tu WhatsApp quedó vinculado a tu cuenta KashBitPay.':
    'No fue posible vincular la cuenta. Genera un nuevo código en tu microaplicación.');
   return;
  }
  if(msg.type==='text')log.log('text:',JSON.stringify(text));
  async function askAmount(){
   log.log('asking amount');
   const result=await messenger.sendMessage(from,'¿Cuánto quieres cobrar?\nEnvía el monto en centavos (1000 = $10.00 MXN)');
   log.log('send result:',JSON.stringify(result).slice(0,200));
   store.conv.set(from,{step:'amount'});
  }
  // Preserve the existing verified cobrar -> amount -> pay/request flow.
  if(text==='cobrar'||text==='start'||text==='/start'){
   await askAmount();return;
  }
  const choice=nav.selection(msg);
  if(choice==='main'){
   store.conv.delete(from);
   await messenger.sendList(from,'KashBitPay: selecciona una opción.','Ver opciones',nav.menuSections());
   return;
  }
  if(choice==='charge'){await askAmount();return;}
  if(choice){
   const url=nav.link(choice,baseUrl||process.env.PUBLIC_BASE_URL);
   if(url){
    store.conv.delete(from);
    await messenger.sendMessage(from,'Abre tu microaplicación:\n'+url+
     '\n\nEl módulo de cuenta está en preparación. Para cobrar escribe cobrar.');
    return;
   }
  }
  const state=store.conv.get(from);
  if(msg.type==='text'&&state?.step==='amount'){
   const amount=/^[1-9][0-9]*$/.test(text)?Number(text):NaN;
   if(!Number.isSafeInteger(amount)){
    await messenger.sendMessage(from,'Monto inválido. Envía un número entero positivo en centavos.');
    return;
   }
   if(!amount||amount<=0){
    await messenger.sendMessage(from,'Monto inválido. Envía un número (1000 = $10.00).');
    return;
   }
   const capRaw=process.env.WABA_MAX_INVITE_CENTS;
   if(capRaw!==undefined){
    const cap=/^[1-9][0-9]*$/.test(capRaw)?Number(capRaw):NaN;
    if(!Number.isSafeInteger(cap)){
     log.error('Invalid WABA_MAX_INVITE_CENTS configuration');
     await messenger.sendMessage(from,'No es posible generar enlaces en este momento.');
     return;
    }
    if(amount>cap){
     await messenger.sendMessage(from,'El importe supera el límite permitido.');
     return;
    }
   }
   const token=store.createInvite(from,amount);
   store.conv.delete(from);
   const base=String(baseUrl||process.env.PUBLIC_BASE_URL||'https://pagos.kashbit.bond').replace(/\/$/,'');
   const url=base+'/pay/request/'+token;
   log.log('payment request link created');
   await messenger.sendMessage(from,'Enlace generado:\n'+url+'\n\nEnvíaselo al pagador.');
   return;
  }
  if(msg.type==='interactive')log.log('Button:',msg.interactive?.button_reply?.id||msg.interactive?.list_reply?.id);
  else if(msg.type==='text')log.log('no match, state:',state);
 }
 async function handleWebhook(body){
  if(!Array.isArray(body?.entry))return;
  for(const entry of body.entry)
   for(const change of entry.changes||[]){
    const value=change.value||{};
    for(const msg of value.messages||[]){
     try{await handleMessage(msg,value.contacts?.[0]);}
     catch(e){log.error('handleMessage error:',e.message);}
    }
   }
 }
 return {handleMessage,handleWebhook};
}
const live=createWebhook();
module.exports={createWebhook,handleWebhook:live.handleWebhook};
