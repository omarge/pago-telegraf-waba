'use strict';
// Based on authoritative Security Engine service/authorize contract in
// omarge/businessos-security-engine. Intention is NOT authorization.
// No network transport or runtime wiring is provided in this module.
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN=/^[A-Za-z0-9._~+\/=-]{16,4096}$/;
function valid(s){return typeof s==='string'&&ID.test(s);}
function buildDelegationIntent({trustedTenantId}={}){
 if(!valid(trustedTenantId))throw Error('R7_TENANT_REQUIRED');
 return Object.freeze({
  targetTenantId:trustedTenantId,audience:'Payment',
  permission:'payment.authorize',scopeType:'TENANT',
  scopeValue:null,scopeTenantId:trustedTenantId,
  targetType:null,targetId:null
 });
}
function validateDelegationDecision({httpStatus,body},intent){
 if(httpStatus===401||httpStatus===403)
  return {state:'DENIED_NO_EFFECT'};
 if(httpStatus!==200||!body||typeof body!=='object'||
    Array.isArray(body)||body.allowed!==true)
  return {state:'UNAVAILABLE_NO_EFFECT'};
 if(body.tenantId!==intent.targetTenantId||
    body.audience!=='Payment'||
    body.permission!=='payment.authorize'||
    body.scopeType!=='TENANT'||body.scopeValue!=null||
    body.scopeTenantId!==intent.scopeTenantId||
    !valid(body.actorId)||!valid(body.actorType)||
    !valid(body.decisionCode)||!TOKEN.test(body.token||''))
  return {state:'INVALID_AUTHORITY_NO_EFFECT'};
 // The token is volatile and must never be persisted in R7 routing tables.
 return {state:'DELEGATED_BOUNDED',trustedTenantId:body.tenantId,
  principalId:body.actorId,delegatedBearer:body.token};
}
function createBusinessosDelegationGate({enabled=false,delegateTransport}={}){
 if(typeof delegateTransport!=='function')throw Error('R7_DELEGATE_REQUIRED');
 async function delegate({trustedTenantId}={}){
  if(enabled!==true)return {state:'DISABLED'};
  let intent;
  try{intent=buildDelegationIntent({trustedTenantId});}
  catch(_e){return {state:'INVALID_INTENT_NO_EFFECT'};}
  try{
   const response=await delegateTransport(intent);
   return validateDelegationDecision(response,intent);
  }catch(_e){return {state:'UNAVAILABLE_NO_EFFECT'};}
 }
 return Object.freeze({delegate,isEnabled:enabled===true});
}
module.exports={buildDelegationIntent,validateDelegationDecision,
 createBusinessosDelegationGate};
