'use strict';
// F04: single Sandbox happy-path per existing WABA payment request.
// This does not replace /pay/charge or allow a second attempt after uncertainty.
function createSavedCardFlow({vault,requestStore,accounts,notify=async()=>{},enabled=false}={}){
 if(!vault||!requestStore||!accounts)throw Error('Saved-card dependencies required');
 function view(accountId,requestId){
  const request=requestStore.getRequest(requestId);
  if(!request)return null;
  return {requestId:request.id,amountCents:request.amount,currency:'MXN',
   state:request.state,cards:vault.profile(accountId).cards,
   pinConfigured:vault.profile(accountId).pinConfigured,
   enabled:enabled&&!!vault.provider?.chargeSavedCard};
 }
 async function pay({accountId,requestId,cardId,pin,deviceSessionId,consent,csrfVerified}){
  const r=requestStore.getRequest(requestId);
  if(!r)return {state:'NOT_FOUND'};
  if(r.state!=='PENDING')return {state:r.state,chargeId:r.providerChargeId||null};
  if(!enabled||!vault.provider?.chargeSavedCard||!vault.provider?.getCharge)
   return {state:'DISABLED'};
  if(!csrfVerified||consent!==true)return {state:'INVALID_CONFIRMATION'};
  if(!Number.isSafeInteger(r.amount)||r.amount<=0)return {state:'INVALID_AMOUNT'};
  if(typeof deviceSessionId!=='string'||!/^[A-Za-z0-9_-]{8,255}$/.test(deviceSessionId))
   return {state:'INVALID_DEVICE'};
  const card=vault.ownedCard(accountId,cardId);
  if(!card||card.merchantId!==vault.provider.merchantId)return {state:'CARD_NOT_FOUND'};
  if(!vault.verifyPin(accountId,pin))return {state:'INVALID_PIN'};
  // Read-only check before the financial POST.
  let checked;
  try{checked=await vault.provider.getCard(card.customerId,card.id);}
  catch(_error){return {state:'CARD_NOT_VERIFIED'};}
  if(checked?.id!==card.id||checked?.customer_id!==card.customerId||
    checked.allows_charges===false)return {state:'CARD_NOT_VERIFIED'};
  if(r.state!=='PENDING')return {state:r.state};
  r.state='SUBMITTING_SAVED_CARD';
  r.payerAccountId=accountId;
  let charge;
  try{
   charge=await vault.provider.chargeSavedCard({
    customerId:card.customerId,cardId:card.id,amountCents:r.amount,
    requestId:r.id,deviceSessionId
   });
   if(typeof charge?.id!=='string'||!charge.id)throw Error('Missing provider charge');
   r.providerChargeId=charge.id;
   // Only an authoritative provider GET marks the request paid.
   const verified=await vault.provider.getCharge(card.customerId,charge.id);
   if(verified?.id!==charge.id||verified?.order_id!==r.id||
     verified?.currency!=='MXN'||Math.round(Number(verified?.amount)*100)!==r.amount||
     verified?.status!=='completed')throw Error('Charge not verified completed');
  }catch(_error){
   r.state='UNKNOWN_SAVED_CARD';
   return {state:r.state,chargeId:r.providerChargeId||null};
  }
  r.state='PAID';
  const amountText=(r.amount/100).toFixed(2);
  const receipt='✅ Pago completado\nSolicitud: '+r.id+
    '\nImporte: $'+amountText+' MXN\nRastreo: '+r.providerChargeId;
  const payer=accounts.getLinkedWhatsApp(accountId);
  const recipients=new Set([r.requesterId,payer].filter(Boolean));
  for(const to of recipients){
   try{await notify(to,receipt);}catch(_error){} // Delivery must not undo PAID.
  }
  return {state:'PAID',chargeId:r.providerChargeId,amountCents:r.amount,
   noticesAttempted:recipients.size};
 }
 return {view,pay};
}
module.exports={createSavedCardFlow};
