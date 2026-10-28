'use strict';
// BusinessOS Payment Engine inbound REST adapter, NOT a payment engine.
// Explicit opt-in only, not registered in the WABA runtime at startup.
const crypto=require('node:crypto');
const ENDPOINT='/internal/v1/payment-authorizations';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORDER=/^KPR-[A-F0-9]{32}$/;
function required(s){
 return typeof s==='string'&&s.length>0&&s.length<=128&&ID.test(s);
}
function decimalMXN(cents){
 if(!Number.isSafeInteger(cents)||cents<=0)
  throw Error('BUSINESSOS_AMOUNT_INVALID');
 return Math.floor(cents/100)+'.'+String(cents%100).padStart(2,'0');
}
function buildAuthorizationRequest({payment,authority}={}){
 if(!payment||!ORDER.test(payment.id||'')||payment.state!=='PENDING'||
    payment.currency!=null&&payment.currency!=='MXN')
  throw Error('BUSINESSOS_REQUEST_NOT_PENDING');
 if(!authority||![
    authority.tenantId,authority.customerId,authority.paymentMethodReferenceProvider,
    authority.paymentMethodReference,authority.fraudAssessmentId
   ].every(required) ||
   typeof authority.clientIpAddress!=='string'||authority.clientIpAddress.length<3||
   authority.clientIpAddress.length>45||!/^[0-9a-fA-F:.]+$/.test(authority.clientIpAddress)||
   authority.fraudDecision!=='APPROVE')
  throw Error('BUSINESSOS_AUTHORITY_NOT_VERIFIED');
 if(!required(authority.accountId)||!required(authority.delegatedBearer)||
    !required(payment.accountId)||authority.accountId!==payment.accountId)
  throw Error('BUSINESSOS_ACCOUNT_SCOPE_MISMATCH');
 const amount=decimalMXN(payment.amount);
 // Channel idempotency is stable by tenant + WABA request; Payment Engine
 // remains the sole authority for economic execution/durable idempotency.
 const digest=crypto.createHash('sha256')
  .update('waba-businessos-auth-v1\n'+authority.tenantId+'\n'+payment.id).digest('hex');
 const body={
  tenantId:authority.tenantId,
  paymentIntentId:'waba-int-'+digest.slice(0,32),
  paymentAttemptId:'waba-att-'+digest.slice(0,32),
  amount,currency:'MXN',
  paymentMethodType:'CARD',paymentChannel:'PAYMENT_LINK',
  businessReferenceType:'ORDER',businessReference:payment.id,
  idempotencyKey:'waba-auth-v1-'+digest,
  paymentMethodReferenceProvider:authority.paymentMethodReferenceProvider,
  paymentMethodReference:authority.paymentMethodReference,
  description:'KashBitPay WABA authorization',
  fraudDeviceSessionReference:authority.fraudDeviceSessionReference||null,
  clientIpAddress:authority.clientIpAddress,
  fraudAssessmentId:authority.fraudAssessmentId,
  fraudDecision:'APPROVE',
  customerId:authority.customerId
 };
 return Object.freeze(body);
}
function normalizeOutcome({httpStatus,body},tenantId){
 if(httpStatus===401||httpStatus===403)
  return {state:'DENIED_SERVICE_AUTH',businessosStatus:null};
 if(!Number.isInteger(httpStatus)||httpStatus>=500||httpStatus===408||httpStatus===429)
  return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
 if(httpStatus!==200&&httpStatus!==409&&httpStatus!==422)
  return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
 if(!body||typeof body!=='object'||Array.isArray(body))
  return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
 const status=body.status;
 const validStatuses={
  AUTHORIZED:{state:'AUTHORIZED_PENDING_CAPTURE',http:200},
  DECLINED:{state:'DECLINED',http:200},
  UNKNOWN:{state:'UNKNOWN_NO_RETRY',http:200},
  CONFLICT:{state:'IDEMPOTENCY_CONFLICT',http:409},
  PRE_EXECUTION_FAILED:{state:'PRE_EXECUTION_FAILED',http:422},
  DENIED:{state:'DENIED_BY_BUSINESSOS',http:422}
 };
 const mapped=Object.prototype.hasOwnProperty.call(validStatuses,status)?
   validStatuses[status]:null;
 if(!mapped||mapped.http!==httpStatus)
  return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
 // Payment Engine echoes the trusted tenant when an authorization had an
 // execution identity. Null tenant is allowed only for pre-exec rejections.
 if((status==='AUTHORIZED'||status==='DECLINED'||status==='UNKNOWN'||status==='CONFLICT')&&
    (body.tenantId!==tenantId||
     !required(body.paymentIntentId)||!required(body.paymentAttemptId)))
  return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
 if(body.tenantId!=null&&body.tenantId!==tenantId)
  return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
 return {
  state:mapped.state,businessosStatus:status,
  // Only canonical, non-secret references; never trust raw failure messages.
  paymentIntentId:required(body.paymentIntentId)?body.paymentIntentId:null,
  paymentAttemptId:required(body.paymentAttemptId)?body.paymentAttemptId:null
 };
}
function createBusinessosAuthorizationAdapter({enabled=false,transport}={}){
 if(typeof transport!=='function')throw Error('BUSINESSOS_TRANSPORT_REQUIRED');
 async function authorize({payment,authority}={}){
  if(enabled!==true)return {state:'DISABLED'};
  let body;
  try{body=buildAuthorizationRequest({payment,authority});}
  catch(_error){return {state:'INVALID_TRUSTED_MAPPING'};}
  try{
   const response=await transport({
    method:'POST',path:ENDPOINT,
    body,delegatedBearer:authority.delegatedBearer
   });
   return normalizeOutcome(response,body.tenantId);
  }catch(_error){
   // Timeout, connection loss, truncated/malformed response: PSP may have
   // been invoked by Payment Engine. NO automatic retry or failover.
   return {state:'UNKNOWN_NO_RETRY',businessosStatus:null};
  }
 }
 return Object.freeze({authorize,isEnabled:enabled===true});
}
module.exports={ENDPOINT,decimalMXN,buildAuthorizationRequest,
 normalizeOutcome,createBusinessosAuthorizationAdapter};
