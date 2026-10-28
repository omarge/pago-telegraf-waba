'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildAuthorizationRequest,decimalMXN,createBusinessosAuthorizationAdapter,ENDPOINT}=require('../src/businessosAuthorizationAdapter');
const {createBusinessosChannelFlow}=require('../src/businessosChannelFlow');
const REQUEST='KPR-'+'A'.repeat(32);
const payment={id:REQUEST,amount:1001,state:'PENDING',currency:'MXN',accountId:'acct-test-123'};
const authority={tenantId:'tenant-test-1',accountId:'acct-test-123',
 customerId:'businessos-customer-123',
 paymentMethodReferenceProvider:'OPENPAY',paymentMethodReference:'vault-opaque-ref-123',
 delegatedBearer:'delegated-offline-test-token-123456789',
 fraudAssessmentId:'fraud-assessment-123',fraudDecision:'APPROVE',
 clientIpAddress:'127.0.0.1',fraudDeviceSessionReference:'device-ref-sandbox-123'};
const approvedResult={httpStatus:200,body:{tenantId:authority.tenantId,
 paymentIntentId:'int-11111111-1111-1111-1111-111111111111',
 paymentAttemptId:'att-11111111-1111-1111-1111-111111111111',
 status:'AUTHORIZED'}};
test('BusinessOS R1 exact REST surface and contract fields from PaymentAuthorizationRequest.java',()=>{
 const b=buildAuthorizationRequest({payment,authority});
 assert.equal(ENDPOINT,'/internal/v1/payment-authorizations');
 assert.equal(b.tenantId,authority.tenantId);
 assert.equal(b.paymentMethodType,'CARD');
 assert.equal(b.paymentChannel,'PAYMENT_LINK');
 assert.equal(b.businessReferenceType,'ORDER');
 assert.equal(b.businessReference,REQUEST);
 assert.equal(b.amount,'10.01');assert.equal(b.currency,'MXN');
 assert.equal(b.paymentMethodReference,'vault-opaque-ref-123');
 assert.equal(b.customerId,'businessos-customer-123');
 assert.equal(b.fraudDecision,'APPROVE');
 assert.equal(b.fraudAssessmentId,'fraud-assessment-123');
 assert.equal(b.clientIpAddress,'127.0.0.1');
 assert.ok(!JSON.stringify(b).includes('delegated-offline-test-token'));
 assert.ok(!JSON.stringify(b).includes('OPENPAY_PRIVATE_KEY'));
 assert.equal(Object.isFrozen(b),true);
});
test('BusinessOS R1 idempotency stable by tenant and request, not by retry/fresh UUID',()=>{
 const a=buildAuthorizationRequest({payment,authority});
 const b=buildAuthorizationRequest({payment,authority});
 assert.deepEqual(a,b);
 assert.notEqual(a.idempotencyKey,buildAuthorizationRequest({payment,
  authority:{...authority,tenantId:'tenant-test-2'}}).idempotencyKey);
 assert.match(a.paymentIntentId,/^waba-int-[0-9a-f]{32}$/);
 assert.match(a.paymentAttemptId,/^waba-att-[0-9a-f]{32}$/);
});
test('BusinessOS R1 no authority from client: refuse missing fraud APPROVE, tenant/customer/method refs',()=>{
 for(const bad of [
  {...authority,tenantId:''},
  {...authority,customerId:''},
  {...authority,paymentMethodReference:''},
  {...authority,fraudDecision:'REVIEW'},
  {...authority,fraudAssessmentId:''},
  {...authority,clientIpAddress:''},
  {...authority,accountId:'different-user'},
  {...authority,delegatedBearer:''}
 ])assert.throws(()=>buildAuthorizationRequest({payment,authority:bad}),/BUSINESSOS_/);
});
test('BusinessOS R1 only a PENDING, positive, canonical WABA order is eligible',()=>{
 for(const bad of [
  {...payment,state:'PAID'},{...payment,state:'UNKNOWN_SAVED_CARD'},
  {...payment,id:'not-valid'}, {...payment,amount:0},
  {...payment,amount:100.1},{...payment,currency:'USD'}
 ])assert.throws(()=>buildAuthorizationRequest({payment:bad,authority}),/BUSINESSOS_/);
 assert.equal(decimalMXN(1),'0.01');
 assert.equal(decimalMXN(Number.MAX_SAFE_INTEGER),'90071992547409.91');
});
test('BusinessOS R1 disabled-by-default returns DISABLED and causes zero transport calls',async()=>{
 let sent=0;
 const adapter=createBusinessosAuthorizationAdapter({transport:async()=>{sent++;return approvedResult;}});
 assert.deepEqual(await adapter.authorize({payment,authority}),{state:'DISABLED'});
 assert.equal(sent,0);
});
test('BusinessOS R1 AUTHORIZED is never PAID or CAPTURED; it awaits owned completion',async()=>{
 let called=0;
 const adapter=createBusinessosAuthorizationAdapter({enabled:true,transport:async input=>{
  called++;assert.equal(input.method,'POST');assert.equal(input.path,ENDPOINT);
  assert.equal(input.body.currency,'MXN');
  assert.equal(input.delegatedBearer,authority.delegatedBearer);
  return approvedResult;
 }});
 const r=await adapter.authorize({payment,authority});
 assert.equal(r.state,'AUTHORIZED_PENDING_CAPTURE');
 assert.equal(r.businessosStatus,'AUTHORIZED');
 assert.equal(called,1);
 assert.equal(r.chargeId,undefined);
 assert.equal(r.state==='PAID',false);
});
test('BusinessOS R1 UNKNOWN results or transport timeouts must NEVER retry or return PAID',async()=>{
 for(const behavior of [
  async()=>{throw Error('ECONNRESET: bearer-secret');},
  async()=>{throw Error('timeout');},
  async()=>({httpStatus:500,body:{error:'internal'}}),
  async()=>({httpStatus:200,body:{status:'UNKNOWN',
   tenantId:authority.tenantId,paymentIntentId:'int-12345',paymentAttemptId:'att-12345'}}),
  async()=>({httpStatus:200,body:'garbled'})
 ]){
  let count=0;
  const adapter=createBusinessosAuthorizationAdapter({enabled:true,
   transport:async (...args)=>{count++;return behavior(...args);}});
  const result=await adapter.authorize({payment,authority});
  assert.equal(result.state,'UNKNOWN_NO_RETRY');
  assert.equal(result.state==='PAID',false);
  assert.equal(count,1);
  assert.equal(JSON.stringify(result).includes('bearer-secret'),false);
 }
});
test('BusinessOS R1 deny, declined and conflict remain distinct, with no cross-tenant trust',async()=>{
 for(const [response,expected] of [
  [{httpStatus:403,body:{}},'DENIED_SERVICE_AUTH'],
  [{httpStatus:401,body:{}},'DENIED_SERVICE_AUTH'],
  [{httpStatus:409,body:{...approvedResult.body,status:'CONFLICT'}},'IDEMPOTENCY_CONFLICT'],
  [{httpStatus:422,body:{status:'PRE_EXECUTION_FAILED',tenantId:null}},'PRE_EXECUTION_FAILED'],
  [{httpStatus:200,body:{...approvedResult.body,status:'DECLINED'}},'DECLINED'],
  [{httpStatus:200,body:{...approvedResult.body,tenantId:'tenant-other'}},'UNKNOWN_NO_RETRY']
 ]){
  const client=createBusinessosAuthorizationAdapter({enabled:true,
   transport:async()=>response});
  assert.equal((await client.authorize({payment,authority})).state,expected);
 }
});
test('BusinessOS R1 channel flow double-click/fake transport concurrency calls upstream exactly once',async()=>{
 const state={id:REQUEST,amount:1001,state:'PENDING'};
 let release,notify,count=0;
 const wait=new Promise(resolve=>{notify=resolve;});
 const gateway=createBusinessosAuthorizationAdapter({enabled:true,transport:async()=>{
  count++;notify();return await new Promise(resolve=>{release=()=>resolve(approvedResult);});
 }});
 const flow=createBusinessosChannelFlow({
  enabled:true,requestStore:{getRequest:id=>id===REQUEST?state:null},
  resolveTrustedAuthority:async()=>authority,adapter:gateway
 });
 const args={accountId:authority.accountId,requestId:REQUEST,consent:true,csrfVerified:true};
 const first=flow.authorize(args);
 await wait;
 const second=flow.authorize(args);
 release();
 const [a,b]=await Promise.all([first,second]);
 assert.equal(count,1);
 assert.equal(a.state,'AUTHORIZED_PENDING_CAPTURE');
 assert.deepEqual(a,b);
 assert.equal(state.state,'PENDING');
});
test('BusinessOS R1 channel flow denies absent confirmation, unrelated account, PAID replay',async()=>{
 let called=0;
 const gateway=createBusinessosAuthorizationAdapter({enabled:true,
  transport:async()=>{called++;return approvedResult;}});
 const r={id:REQUEST,amount:1001,state:'PENDING'};
 const flow=createBusinessosChannelFlow({
  enabled:true,requestStore:{getRequest:()=>r},
  resolveTrustedAuthority:async()=>authority,adapter:gateway
 });
 const args={accountId:'other-user',requestId:REQUEST,consent:true,csrfVerified:true};
 assert.equal((await flow.authorize(args)).state,'INVALID_TRUSTED_MAPPING');
 assert.equal((await flow.authorize({...args,accountId:authority.accountId,consent:false})).state,'INVALID_CONFIRMATION');
 r.state='PAID';
 assert.equal((await flow.authorize({...args,accountId:authority.accountId})).state,'NOT_PENDING');
 assert.equal(called,0);
});
test('BusinessOS R1 opt-in channel flow still avoids any direct Openpay, WhatsApp or F05 journal',async()=>{
 const flow=createBusinessosChannelFlow({enabled:false,
  requestStore:{getRequest:()=>{throw Error('no request when disabled');}},
  resolveTrustedAuthority:async()=>{throw Error('no map when disabled');},
  adapter:{authorize:async()=>{throw Error('no call when disabled');}}
 });
 assert.equal((await flow.authorize({})).state,'DISABLED');
});

test('BusinessOS R1 delegated Security Engine bearer may be >128 chars but never enters payment body',async()=>{
 const jwt='eyJhbGciOiJSUzI1NiJ9.'+'a'.repeat(440)+'.'+'b'.repeat(440);
 const trusted={...authority,delegatedBearer:jwt};
 const payload=buildAuthorizationRequest({payment,authority:trusted});
 assert.ok(!JSON.stringify(payload).includes(jwt));
 let seen=0;
 const adapter=createBusinessosAuthorizationAdapter({enabled:true,transport:async request=>{
  seen++;
  assert.equal(request.delegatedBearer,jwt);
  assert.ok(!JSON.stringify(request.body).includes(jwt));
  return approvedResult;
 }});
 const result=await adapter.authorize({payment,authority:trusted});
 assert.equal(result.state,'AUTHORIZED_PENDING_CAPTURE');
 assert.equal(seen,1);
});
