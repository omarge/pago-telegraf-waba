'use strict';
// R10 is OFFLINE and cannot authorize a real payment. No PSP/Fraud/Security calls.
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareCanonicalFraudAssessment,validateFraudAssessmentResponse,decimal}=
 require('../src/businessosCanonicalFraud');
const {createR10CanonicalEvidenceGate}=require('../src/businessosCanonicalEvidenceGate');
const REQUEST='KPR-'+'A'.repeat(32);
const accountId='waba-local-account-r10';
const tenant='tenant-businessos-r10',customer='canonical-customer-r10';
const request={id:REQUEST,state:'PENDING',payerAccountId:accountId,
 amount:1275,currency:'MXN',createdAt:'2026-10-28T18:20:00.000Z'};
const identity={
 source:'BUSINESSOS_CANONICAL',accountId,tenantId:tenant,
 customerId:customer,merchantId:'merchant-businessos-r10',
 providerAccountId:'businessos-provider-account-r10',
 customerVaultTenantId:tenant,customerVaultCustomerId:customer,
 customerVaultStatus:'ACTIVE'
};
const method={
 source:'BUSINESSOS_VAULT',status:'ACTIVE',tenantId:tenant,
 customerId:customer,providerAccountId:identity.providerAccountId,
 provider:'OPENPAY',opaqueReference:'canonical-provider-reference-r10',
 fraudVaultToken:'businessos-risk-vault-token-r10',
 bin:'411111',last4:'1234'
};
const device={fingerprint:'verified-server-fingerprint-r10',ip:'127.0.0.1'};
const assessment={
 assessmentId:'11111111-2222-4333-8444-555555555555',
 decision:'APPROVE',score:0.07,modelVersion:'fraud-r10-test-version',
 reasons:[{code:'RISK_CLEAR',description:'synthetic fixture'}]
};
const response=(body=assessment,transportTenantId=tenant)=>({
 httpStatus:200,body,transportTenantId,tenantContextVerified:true
});
const packet=props=>prepareCanonicalFraudAssessment({
 request,accountId,identity,method,device,...props
});
function makeGate({
 enabled=true,identityResult=identity,methodResult=method,
 delegation={state:'DELEGATED_BOUNDED',trustedTenantId:tenant,
   principalId:'waba-s2s-principal',delegatedBearer:'delegated-test-token-123456'},
 result=response(),identityThrows=false,methodThrows=false,
 delegationThrows=false,fraudThrows=false
}={}){
 const calls={identity:0,vault:0,security:0,fraud:0,wire:null};
 const gate=createR10CanonicalEvidenceGate({
  enabled,
  loadCanonicalIdentity:async input=>{
   calls.identity++;assert.deepEqual(input,{accountId,requestId:REQUEST});
   if(identityThrows)throw Error('PRIVATE_INTERNAL_IDENTITY_DB');
   return identityResult;
  },
  loadVaultMethod:async input=>{
   calls.vault++;
   assert.deepEqual(input,{accountId,requestId:REQUEST,tenantId:identityResult.tenantId,
    customerId:identityResult.customerId});
   if(methodThrows)throw Error('PRIVATE_VAULT_TOKEN');
   return methodResult;
  },
  securityDelegate:async input=>{
   calls.security++;assert.deepEqual(input,{trustedTenantId:tenant});
   if(delegationThrows)throw Error('SECRET_SERVICE_CREDENTIAL');
   return delegation;
  },
  assessFraud:async input=>{
   calls.fraud++;calls.wire=input;
   if(fraudThrows)throw Error('PRIVATE_FRAUD_TRANSPORT_TOKEN');
   return result;
  }
 });
 return {gate,calls};
}
test('R10 Fraud AssessmentRequest matches real Fraud Engine DTO and stable idempotency key',()=>{
 const p=packet();
 assert.deepEqual(p.fraudRequest,{
  paymentId:REQUEST,merchantId:identity.merchantId,customerId:customer,
  amount:{value:'12.75',currency:'MXN'},
  method:{type:'CARD',vaultToken:method.fraudVaultToken,
   bin:'411111',last4:'1234'},
  device,occurredAt:request.createdAt
 });
 assert.match(p.idempotencyKey,/^waba-fraud-v1-[0-9a-f]{64}$/);
 assert.deepEqual(packet(),p);
 assert.notEqual(packet({identity:{...identity,tenantId:'tenant-other',
  customerVaultTenantId:'tenant-other'},method:{...method,
   tenantId:'tenant-other'}}).idempotencyKey,p.idempotencyKey);
 assert.equal(decimal(1),'0.01');
 assert.equal(decimal(1275),'12.75');
 assert.equal(p.fraudRequest.tenantId,undefined);
 assert.equal(p.fraudRequest.idempotencyKey,undefined);
});
test('R10 canonical customer identity is never WABA account or Openpay customer token',()=>{
 assert.equal(packet().paymentEvidence.customerId,customer);
 assert.equal(packet().paymentEvidence.paymentMethodReferenceProvider,'OPENPAY');
 assert.equal(packet().paymentEvidence.paymentMethodReference,method.opaqueReference);
 assert.notEqual(packet().paymentEvidence.customerId,accountId);
 assert.notEqual(packet().paymentEvidence.customerId,method.fraudVaultToken);
 for(const bad of [
  {...identity,source:'BROWSER'},
  {...identity,customerId:'OPENPAY_CUSTOMER_TOKEN'},
  {...identity,customerVaultStatus:'UNKNOWN'},
  {...identity,customerVaultStatus:'CREATING'},
  {...identity,customerVaultStatus:'FAILED'},
  {...identity,customerVaultStatus:'DELETED'},
  {...identity,customerVaultTenantId:'another-tenant'},
  {...identity,customerVaultCustomerId:'someone-else'},
  {...identity,accountId:'other-waba'}
 ]){
  assert.throws(()=>packet({identity:bad}),/R10_CUSTOMER_VAULT_UNVERIFIED/);
 }
});
test('R10 vault reference must belong to same tenant, customer and provider account',()=>{
 for(const bad of [
  {...method,source:'OPENPAY_BROWSER_TOKEN'},
  {...method,status:'UNKNOWN'},
  {...method,status:'DELETED'},
  {...method,tenantId:'another-tenant'},
  {...method,customerId:'another-customer'},
  {...method,providerAccountId:'another-provider-account'},
  {...method,provider:''},
  {...method,opaqueReference:''},
  {...method,fraudVaultToken:''},
  {...method,bin:''},
  {...method,last4:'123'},
  {...method,bin:'41111199PAN'}
 ])assert.throws(()=>packet({method:bad}),/R10_PAYMENT_METHOD_UNVERIFIED/);
});
test('R10 account binding, amount, status and immutable risk timestamp are mandatory',()=>{
 for(const bad of [
  {...request,payerAccountId:'attacker'},
  {...request,state:'PAID'},
  {...request,state:'UNKNOWN'},
  {...request,amount:0},
  {...request,amount:12.75},
  {...request,id:'not-a-KPR'},
  {...request,currency:'USD'},
  {...request,createdAt:undefined},
  {...request,createdAt:'2026-10-28'},
  {...request,createdAt:'2026-13-28T18:20:00.000Z'}
 ])assert.throws(()=>packet({request:bad}),/R10_PAYER_REQUEST_UNVERIFIED/);
});
test('R10 device metadata must come from server-bound context, no invalid IP or fingerprint',()=>{
 for(const bad of [
  {...device,fingerprint:''},
  {...device,fingerprint:'browser injected data'},
  {...device,ip:'not-an-ip'},
  {...device,ip:'127.0.0.1\nAuthorization: evil'}
 ])assert.throws(()=>packet({device:bad}),/R10_DEVICE_UNVERIFIED/);
});
test('R10 Fraud response APPROVE not accepted without verified tenant-scope adapter',()=>{
 const cases=[
  {httpStatus:200,body:assessment,transportTenantId:tenant},
  {httpStatus:200,body:assessment,transportTenantId:'other',tenantContextVerified:true},
  {httpStatus:200,body:assessment,tenantContextVerified:true},
  {httpStatus:500,body:assessment,transportTenantId:tenant,tenantContextVerified:true},
  {httpStatus:409,body:assessment,transportTenantId:tenant,tenantContextVerified:true}
 ];
 const expected=['FRAUD_TENANT_UNVERIFIED','FRAUD_TENANT_UNVERIFIED',
  'FRAUD_TENANT_UNVERIFIED','FRAUD_UNKNOWN_HOLD_NO_AUTO_RETRY',
  'FRAUD_UNKNOWN_HOLD_NO_AUTO_RETRY'];
 cases.forEach((c,i)=>assert.equal(validateFraudAssessmentResponse(c,tenant).state,expected[i]));
});
test('R10 Fraud decisions CHALLENGE REVIEW DECLINE always block Payment evidence',()=>{
 for(const decision of ['CHALLENGE','REVIEW','DECLINE']){
  const r=validateFraudAssessmentResponse(response({...assessment,decision}),tenant);
  assert.deepEqual(r,{state:'FRAUD_NOT_APPROVED',decision});
 }
});
test('R10 invalid Fraud ID, score, model and reasons cannot be upgraded to APPROVE',()=>{
 for(const bad of [
  {...assessment,assessmentId:'not-a-uuid'},
  {...assessment,decision:'PAID'},
  {...assessment,score:NaN},
  {...assessment,score:1.5},
  {...assessment,score:-0.01},
  {...assessment,modelVersion:''},
  {...assessment,reasons:null},
  {...assessment,reasons:[{code:''}]}
 ])assert.equal(validateFraudAssessmentResponse(response(bad),tenant).state,
  'FRAUD_RESPONSE_UNVERIFIED');
});
test('R10 default DISABLED never reads canonical identity, vault, Security Engine or Fraud',async()=>{
 const {gate,calls}=makeGate({enabled:false});
 assert.deepEqual(await gate.prepare({request,accountId,device}),{state:'DISABLED'});
 assert.deepEqual(calls,{identity:0,vault:0,security:0,fraud:0,wire:null});
 assert.equal(gate.isPaymentDispatcher,false);
});
test('R10 request from foreign account is rejected before any trusted port',async()=>{
 const {gate,calls}=makeGate();
 assert.equal((await gate.prepare({request:{...request,payerAccountId:'other'},
  accountId,device})).state,'REQUEST_UNVERIFIED');
 assert.equal(calls.identity,0);
});
test('R10 canonical and vault lookup errors stop before delegation and Fraud',async()=>{
 for(const options of [{identityThrows:true},{methodThrows:true},
  {identityResult:{...identity,customerVaultStatus:'UNKNOWN'}},
  {methodResult:{...method,tenantId:'other'}}]){
  const {gate,calls}=makeGate(options);
  const r=await gate.prepare({request,accountId,device});
  assert.notEqual(r.state,'EVIDENCE_CANDIDATE_OFFLINE_ONLY');
  assert.equal(calls.security,0);
  assert.equal(calls.fraud,0);
 }
});
test('R10 no Fraud call on missing, refused or mismatched Security Engine authority',async()=>{
 for(const delegation of [
  {state:'DENIED_NO_EFFECT'},
  {state:'UNAVAILABLE_NO_EFFECT'},
  {state:'DELEGATED_BOUNDED',trustedTenantId:'other',
   delegatedBearer:'delegated-other-token-12345'},
  {state:'DELEGATED_BOUNDED',trustedTenantId:tenant,delegatedBearer:''}
 ]){
  const {gate,calls}=makeGate({delegation});
  assert.equal((await gate.prepare({request,accountId,device})).state,
   'SECURITY_ENGINE_NOT_AUTHORIZED');
  assert.equal(calls.security,1);
  assert.equal(calls.fraud,0);
 }
 const {gate,calls}=makeGate({delegationThrows:true});
 assert.equal((await gate.prepare({request,accountId,device})).state,
  'SECURITY_ENGINE_UNAVAILABLE');
 assert.equal(calls.fraud,0);
});
test('R10 Fraud timeout is UNKNOWN_HOLD, no manufactured APPROVE',async()=>{
 const {gate,calls}=makeGate({fraudThrows:true});
 assert.equal((await gate.prepare({request,accountId,device})).state,
  'FRAUD_UNKNOWN_HOLD_NO_AUTO_RETRY');
 assert.equal(calls.fraud,1);
});
test('R10 valid mocked trusted evidence only returns CANDIDATE, never Payment AUTHORIZED/PAID',async()=>{
 const {gate,calls}=makeGate();
 const r=await gate.prepare({request,accountId,device});
 assert.deepEqual(r,{
  state:'EVIDENCE_CANDIDATE_OFFLINE_ONLY',customerId:customer,
  tenantId:tenant,assessmentId:assessment.assessmentId,requestId:REQUEST
 });
 assert.equal(calls.identity,1);
 assert.equal(calls.vault,1);
 assert.equal(calls.security,1);
 assert.equal(calls.fraud,1);
 assert.equal(calls.wire.trustedTenantId,tenant);
 assert.match(calls.wire.idempotencyKey,/^waba-fraud-v1-[0-9a-f]{64}$/);
 assert.deepEqual(calls.wire.body,packet().fraudRequest);
 assert.equal('delegatedBearer' in calls.wire,false);
 assert.equal('fraudDecision' in calls.wire.body,false);
 assert.equal(r.state==='PAID'||r.state==='AUTHORIZED',false);
 assert.equal('paymentMethodReference' in r,false);
});
test('R10 fraudulent caller-supplied APPROVE or vault reference is ignored',async()=>{
 const {gate,calls}=makeGate();
 const forged={...request,fraudDecision:'APPROVE',
  fraudAssessmentId:'attacker-fraud',customerId:'attacker',
  paymentMethodReference:'OPENPAY_TOKEN',tenantId:'attacker',
  delegatedBearer:'attacker-token-00000000000'};
 const r=await gate.prepare({request:forged,accountId,device});
 assert.equal(r.state,'EVIDENCE_CANDIDATE_OFFLINE_ONLY');
 assert.equal(calls.wire.body.customerId,customer);
 assert.equal('fraudDecision' in calls.wire.body,false);
 assert.notEqual(calls.wire.body.customerId,forged.customerId);
 assert.notEqual(r.assessmentId,forged.fraudAssessmentId);
});
