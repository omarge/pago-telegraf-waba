'use strict';
// R10: canonical identity + CustomerVault evidence from TRUSTED internal ports.
// No public CustomerVault REST endpoint is assumed. No Payment execution.
const crypto=require('node:crypto');
const net=require('node:net');
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE=/^[A-Za-z0-9][A-Za-z0-9._:\/=-]{0,255}$/;
function id(x){return typeof x==='string'&&ID.test(x);}
function money(x){return Number.isSafeInteger(x)&&x>0;}
function decimal(cents){
 if(!money(cents))throw Error('R10_AMOUNT_INVALID');
 return Math.floor(cents/100)+'.'+String(cents%100).padStart(2,'0');
}
function canonicalTimestamp(v){
 if(typeof v!=='string'||!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v))
  return false;
 const t=new Date(v);
 return !Number.isNaN(t.getTime())&&t.toISOString()===v;
}
function prepareCanonicalFraudAssessment({request,accountId,identity,method,device}={}){
 if(!request||!ORDER.test(request.id||'')||request.state!=='PENDING'||
    (request.currency!=null&&request.currency!=='MXN')||
    !money(request.amount)||!id(accountId)||
    request.payerAccountId!==accountId||!canonicalTimestamp(request.createdAt))
  throw Error('R10_PAYER_REQUEST_UNVERIFIED');
 // Identity may only originate from an injected server-side canonical resolver.
 // A WABA account id, WhatsApp phone or Openpay customer id is not customerId.
 if(!identity||identity.source!=='BUSINESSOS_CANONICAL'||
    ![identity.accountId,identity.tenantId,identity.customerId,
      identity.merchantId,identity.providerAccountId,
      identity.customerVaultTenantId,identity.customerVaultCustomerId].every(id)||
    identity.accountId!==accountId||
    identity.customerVaultTenantId!==identity.tenantId||
    identity.customerVaultCustomerId!==identity.customerId||
    identity.customerVaultStatus!=='ACTIVE')
  throw Error('R10_CUSTOMER_VAULT_UNVERIFIED');
 if(!method||method.source!=='BUSINESSOS_VAULT'||
    method.status!=='ACTIVE'||method.tenantId!==identity.tenantId||
    method.customerId!==identity.customerId||
    method.providerAccountId!==identity.providerAccountId||
    !id(method.provider)||!OPAQUE.test(method.opaqueReference||'')||
    !OPAQUE.test(method.fraudVaultToken||'')||
    !/^\d{6,8}$/.test(method.bin||'')||!/^\d{4}$/.test(method.last4||''))
  throw Error('R10_PAYMENT_METHOD_UNVERIFIED');
 if(!device||typeof device.fingerprint!=='string'||
    !id(device.fingerprint)||net.isIP(device.ip)!==4&&net.isIP(device.ip)!==6)
  throw Error('R10_DEVICE_UNVERIFIED');
 // Fraud assessment REST DTO is verified from Fraud Engine AssessmentRequest.
 // Fraud owns idempotent persistence keyed by (trusted tenant, Idempotency-Key).
 const digest=crypto.createHash('sha256').update(
  'waba-businessos-fraud-v1\n'+identity.tenantId+'\n'+request.id).digest('hex');
 const fraudRequest={
  paymentId:request.id,merchantId:identity.merchantId,
  customerId:identity.customerId,
  amount:{value:decimal(request.amount),currency:'MXN'},
  method:{
   type:'CARD',vaultToken:method.fraudVaultToken,
   bin:method.bin,last4:method.last4
  },
  device:{fingerprint:device.fingerprint,ip:device.ip},
  occurredAt:request.createdAt
 };
 const paymentEvidence={
  accountId,tenantId:identity.tenantId,customerId:identity.customerId,
  paymentMethodReferenceProvider:method.provider,
  paymentMethodReference:method.opaqueReference,
  providerAccountId:identity.providerAccountId,merchantId:identity.merchantId,
  requestId:request.id,amountCents:request.amount
 };
 return Object.freeze({
  tenantId:identity.tenantId,
  idempotencyKey:'waba-fraud-v1-'+digest,
  fraudRequest:Object.freeze(fraudRequest),
  paymentEvidence:Object.freeze(paymentEvidence)
 });
}
function validateFraudAssessmentResponse({httpStatus,body,transportTenantId,
 tenantContextVerified}={},expectedTenant){
 // The official Fraud Engine AssessmentResponse JSON does NOT carry tenantId;
 // this extra transportTenantId is local adapter metadata, not a wire field.
 // A trusted adapter MUST enforce tenancy before declaring verified=true.
 if(httpStatus!==200)
  return {state:'FRAUD_UNKNOWN_HOLD_NO_AUTO_RETRY'};
 if(tenantContextVerified!==true||transportTenantId!==expectedTenant)
  return {state:'FRAUD_TENANT_UNVERIFIED'};
 if(!body||typeof body!=='object'||Array.isArray(body)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.assessmentId||'')||
    !['APPROVE','CHALLENGE','REVIEW','DECLINE'].includes(body.decision)||
    typeof body.score!=='number'||!Number.isFinite(body.score)||
    body.score<0||body.score>1||
    !id(body.modelVersion)||!Array.isArray(body.reasons)||
    body.reasons.length>100||
    body.reasons.some(x=>!x||typeof x!=='object'||!id(x.code)))
  return {state:'FRAUD_RESPONSE_UNVERIFIED'};
 if(body.decision!=='APPROVE')
  return {state:'FRAUD_NOT_APPROVED',decision:body.decision};
 return {state:'FRAUD_APPROVE_CANDIDATE_ONLY',
  assessmentId:body.assessmentId};
}
module.exports={decimal,prepareCanonicalFraudAssessment,
 validateFraudAssessmentResponse};
