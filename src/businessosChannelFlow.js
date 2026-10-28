'use strict';
// Trusted orchestration boundary for a future authenticated WABA route.
// Does NOT register any web endpoint or mutate request/payment/journal state.
// Security Engine tenant/customer/method/fraud mapping must be resolved by a
// trusted server dependency, NOT from user POST or a WABA/Openpay card id.
function createBusinessosChannelFlow({enabled=false,requestStore,
  resolveTrustedAuthority,adapter}={}){
 if(!requestStore||typeof requestStore.getRequest!=='function'||
    typeof resolveTrustedAuthority!=='function'||
    !adapter||typeof adapter.authorize!=='function')
  throw Error('BUSINESSOS_CHANNEL_DEPENDENCY_MISSING');
 const attempts=new Map();
 async function authorize({accountId,requestId,consent,csrfVerified}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(consent!==true||csrfVerified!==true)return {state:'INVALID_CONFIRMATION'};
  const request=requestStore.getRequest(requestId);
  if(!request||request.id!==requestId)return {state:'NOT_FOUND'};
  if(request.state!=='PENDING')return {state:'NOT_PENDING'};
  if(attempts.has(requestId))return attempts.get(requestId);
  // Single process guard to avoid duplicate outbound POST from double clicks.
  // This is NOT durable; BusinessOS owns the cross-process idempotency.
  const task=(async()=>{
   let authority;
   try{authority=await resolveTrustedAuthority({accountId,requestId});}
   catch(_error){return {state:'INVALID_TRUSTED_MAPPING'};}
   if(!authority||authority.accountId!==accountId)return {state:'INVALID_TRUSTED_MAPPING'};
   const payment={id:request.id,amount:request.amount,state:request.state,
    currency:'MXN',accountId};
   // No direct Openpay, PAID, F05 journal, WhatsApp or BusinessOS events.
   return adapter.authorize({payment,authority});
  })();
  attempts.set(requestId,task);
  const outcome=await task;
  if(outcome.state==='INVALID_TRUSTED_MAPPING'||outcome.state==='DISABLED'){
   attempts.delete(requestId);
  }
  return outcome;
 }
 return Object.freeze({authorize,isEnabled:enabled===true});
}
module.exports={createBusinessosChannelFlow};
