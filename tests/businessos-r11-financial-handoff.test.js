'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createPostgresChannelStore}=require('../src/businessosPgChannelStore');
const {createBusinessosAuthorizationAdapter}=require('../src/businessosAuthorizationAdapter');
const {createR11FencedAuthorization}=require('../src/businessosR11FencedAuthorization');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const REQUEST=n=>'KPR-'+'F'.repeat(30)+'0'+n;
const PAYER='waba-payer-r11',OTHER='waba-attacker-r11',FROM='5215555550002';
const TENANT='tenant-businessos-r11',CUSTOMER='canonical-customer-r11';
const FRAUD='11111111-2222-4333-8444-555555555555';
const TOKEN='delegated-payment-token-r11-fake-123456789';
const authority=(request)=>({
 tenantId:TENANT,customerId:CUSTOMER,accountId:PAYER,
 paymentMethodReferenceProvider:'OPENPAY',paymentMethodReference:'vault-opaque-r11',
 delegatedBearer:TOKEN,fraudAssessmentId:FRAUD,fraudDecision:'APPROVE',
 clientIpAddress:'127.0.0.1',
 fraudDeviceSessionReference:'device-r11'
});
function evidence(request){
 return {state:'EVIDENCE_CANDIDATE_OFFLINE_ONLY',requestId:request.id,
  tenantId:TENANT,customerId:CUSTOMER,assessmentId:FRAUD};
}
let pool,store;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:24});
  await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r11-channel.sql']);
  store=createPostgresChannelStore({pool});
 });
 after(async()=>{if(pool)await pool.end();});
}
async function setup(n,amount=1250){
 const requestId=REQUEST(n);
 assert.equal((await store.createRequest({requestId,requesterId:FROM,amountCents:amount})).state,'CREATED');
 assert.equal((await store.bindPayer({
  requestId,payerAccountId:PAYER,requesterId:FROM,amountCents:amount
 })).state,'BOUND');
 return requestId;
}
function fixture({enabled=true,permission=true,verdict=null,send=null,
 evidenceResolver=null,authorityResolver=null,deviceResolver=null}={}){
 const calls={evidence:0,authority:0,device:0,transport:0};
 const gate={prepare:async args=>{
  calls.evidence++;
  return evidenceResolver?evidenceResolver(args):permission?evidence(args.request):
   {state:'FRAUD_NOT_APPROVED'};
 }};
 const adapter=createBusinessosAuthorizationAdapter({enabled:true,transport:async req=>{
  calls.transport++;
  if(send)return send(req);
  return {httpStatus:200,body:{
   status:verdict||'AUTHORIZED',tenantId:TENANT,
   paymentIntentId:req.body.paymentIntentId,
   paymentAttemptId:req.body.paymentAttemptId
  }};
 }});
 const flow=createR11FencedAuthorization({enabled,pool,
  prepareEvidence:gate,adapter,
  resolveDevice:async args=>{
   calls.device++;
   return deviceResolver?deviceResolver(args):
    {fingerprint:'device-r11',ip:'127.0.0.1'};
  },
  resolveAuthority:async args=>{
   calls.authority++;
   return authorityResolver?authorityResolver(args):authority(args.request);
  }
 });
 return {calls,flow};
}
const args=requestId=>({requestId,accountId:PAYER,consent:true,csrfVerified:true});
async function row(id){
 const r=await pool.query('SELECT * FROM waba_channel.payment_authorization_handoffs WHERE request_id=$1',[id]);
 return r.rows[0]||null;
}
async function reserveRow(id){
 const r=await pool.query('SELECT * FROM waba_channel.authorization_reservations WHERE request_id=$1',[id]);
 return r.rows[0]||null;
}
pgTest('R11 disabled by default rejects before database/evidence/transport',async()=>{
 const id=REQUEST('A'),f=fixture({enabled:false});
 assert.deepEqual(await f.flow.authorizeOnce(args(id)),{state:'DISABLED'});
 assert.deepEqual(f.calls,{evidence:0,authority:0,device:0,transport:0});
});
pgTest('R11 live-eligible fake authority creates both fence rows before single Payment attempt',async()=>{
 const id=await setup('B',1275),f=fixture();
 const result=await f.flow.authorizeOnce(args(id));
 assert.deepEqual(result,{state:'AUTHORIZED_PENDING_CAPTURE_NOT_PAID'});
 assert.equal(f.calls.transport,1);
 const handoff=await row(id),reservation=await reserveRow(id);
 assert.ok(handoff);assert.ok(reservation);
 assert.equal(handoff.tenant_id,TENANT);
 assert.equal(handoff.customer_id,CUSTOMER);
 assert.equal(handoff.fraud_assessment_id,FRAUD);
 assert.equal(Number(handoff.amount_cents),1275);
 assert.equal(handoff.payer_account_id,PAYER);
 assert.equal(handoff.outcome,'AUTHORIZED_PENDING_CAPTURE');
 assert.equal(reservation.idempotency_key,handoff.idempotency_key);
 assert.ok(handoff.finalized_at);
 assert.equal((await store.getRequest(id)).state,'PENDING');
 assert.equal(Object.keys(handoff).some(x=>/token|bearer|method_reference|pan|card/i.test(x)),false);
 assert.equal(JSON.stringify(handoff).includes(TOKEN),false);
 const replay=await f.flow.authorizeOnce(args(id));
 assert.equal(replay.state,'HOLD_NO_AUTO_RETRY');
 assert.equal(f.calls.transport,1);
});
pgTest('R11 concurrent processes cannot issue duplicate financial POST',async()=>{
 const id=await setup('C'),calls={n:0};
 const send=async req=>{
  calls.n++;
  await new Promise(done=>setTimeout(done,30));
  return {httpStatus:200,body:{status:'AUTHORIZED',
   tenantId:TENANT,paymentIntentId:req.body.paymentIntentId,
   paymentAttemptId:req.body.paymentAttemptId}};
 };
 const worker=Array.from({length:16},()=>fixture({send}).flow);
 const responses=await Promise.all(worker.map(flow=>flow.authorizeOnce(args(id))));
 assert.equal(calls.n,1);
 assert.equal(responses.filter(x=>x.state==='AUTHORIZED_PENDING_CAPTURE_NOT_PAID').length,1);
 assert.equal(responses.filter(x=>x.state==='HOLD_NO_AUTO_RETRY').length,15);
 assert.equal((await row(id)).outcome,'AUTHORIZED_PENDING_CAPTURE');
});
pgTest('R11 cross-account, absent consent/CSRF, unknown request have zero trusted calls',async()=>{
 const id=await setup('D'),f=fixture();
 for(const bad of [
  {...args(id),accountId:OTHER},
  {...args(id),consent:false},
  {...args(id),csrfVerified:false},
  {...args(REQUEST('E'))},
  {...args(id),requestId:'invalid-KPR'}
 ]){
  const r=await f.flow.authorizeOnce(bad);
  assert.notEqual(r.state,'AUTHORIZED_PENDING_CAPTURE_NOT_PAID');
 }
 assert.deepEqual(f.calls,{evidence:0,authority:0,device:0,transport:0});
});
pgTest('R11 Fraud denied or unknown evidence never reserves and cannot invoke Payment',async()=>{
 const id=await setup('F'),f=fixture({permission:false});
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'EVIDENCE_NOT_AUTHORIZED');
 assert.equal(f.calls.transport,0);assert.equal(f.calls.authority,0);
 assert.equal(await row(id),null);
 assert.equal(await reserveRow(id),null);
});
pgTest('R11 mismatched customer, tenant, fraud assessment or delegated bearer fail closed',async()=>{
 const id=await setup('1');
 for(const change of [
  {tenantId:'tenant-other'},
  {customerId:'other-customer'},
  {fraudAssessmentId:'22222222-2222-4333-8444-555555555555'},
  {accountId:OTHER},
  {fraudDecision:'REVIEW'},
  {delegatedBearer:''},
  {paymentMethodReference:''}
 ]){
  const f=fixture({authorityResolver:async({request})=>({...authority(request),...change})});
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'TRUSTED_MAPPING_UNVERIFIED');
  assert.equal(f.calls.transport,0);
  assert.equal(await reserveRow(id),null);
 }
});
pgTest('R11 immutable request snapshots are revalidated after all asynchronous lookups',async()=>{
 const id=await setup('2',2700);
 let release,signal;
 const started=new Promise(ok=>{signal=ok;});
 const f=fixture({authorityResolver:async({request})=>{
  signal();
  await new Promise(ok=>{release=ok;});
  return authority(request);
 }});
 const running=f.flow.authorizeOnce(args(id));
 await started;
 await pool.query('UPDATE waba_channel.requests SET amount_cents=$2 WHERE request_id=$1',[id,50000]);
 release();
 assert.equal((await running).state,'REQUEST_CHANGED_NO_EFFECT');
 assert.equal(f.calls.transport,0);
 assert.equal(await reserveRow(id),null);
 assert.equal(await row(id),null);
});
pgTest('R11 R4 previous reservation prevents any second Payment attempt',async()=>{
 const id=await setup('3');
 assert.equal((await store.reserveAuthorization({
  requestId:id,payerAccountId:PAYER,idempotencyKey:'r11-preexisting-r4-reservation-001'
 })).state,'RESERVED_NO_AUTO_RETRY');
 const f=fixture();
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'HOLD_NO_AUTO_RETRY');
 assert.equal(f.calls.transport,0);
 assert.equal(await row(id),null);
});
pgTest('R11 transport timeout/unknown holds forever including new process',async()=>{
 const id=await setup('4');
 const f=fixture({send:async()=>{throw Error('FAKE PAYMENT_POST_TIMEOUT');}});
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'UNKNOWN_HOLD_NO_AUTO_RETRY');
 assert.equal((await row(id)).outcome,'UNKNOWN_HOLD');
 assert.equal(f.calls.transport,1);
 const other=fixture();
 assert.equal((await other.flow.authorizeOnce(args(id))).state,'HOLD_NO_AUTO_RETRY');
 assert.equal(other.calls.transport,0);
});
pgTest('R11 5xx and UNKNOWN Payment response never induce automatic replay',async()=>{
 const id=await setup('5');
 const f=fixture({send:async()=>({httpStatus:503,body:null})});
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'UNKNOWN_HOLD_NO_AUTO_RETRY');
 assert.equal((await row(id)).outcome,'UNKNOWN_HOLD');
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'HOLD_NO_AUTO_RETRY');
 assert.equal(f.calls.transport,1);
});
pgTest('R11 payment AUTHORIZED response with wrong intent/attempt cannot be accepted',async()=>{
 const id=await setup('6');
 const f=fixture({send:async()=>({httpStatus:200,body:{
  status:'AUTHORIZED',tenantId:TENANT,
  paymentIntentId:'forged-intent',paymentAttemptId:'forged-attempt'
 }})});
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'UNKNOWN_HOLD_NO_AUTO_RETRY');
 assert.equal((await row(id)).outcome,'UNKNOWN_HOLD');
 assert.equal(f.calls.transport,1);
});
pgTest('R11 DECLINED is recorded but never leads to retries or PAID',async()=>{
 const id=await setup('7'),f=fixture({verdict:'DECLINED'});
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'DECLINED');
 assert.equal((await row(id)).outcome,'DECLINED');
 assert.equal((await store.getRequest(id)).state,'PENDING');
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'HOLD_NO_AUTO_RETRY');
 assert.equal(f.calls.transport,1);
});
pgTest('H1: a different vault method after Fraud cannot authorize Payment',async()=>{
  const id=await setup('G');
  const f=fixture({authorityResolver:async({request})=>({
    ...authority(request),paymentMethodReference:'vault-substituted-r11'
  })});
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'TRUSTED_MAPPING_UNVERIFIED');
  assert.equal(f.calls.transport,0);
  assert.equal(await row(id),null);
  assert.equal(await reserveRow(id),null);
});
pgTest('H1: changing provider account and merchant after Fraud must fail closed',async()=>{
  const id=await setup('H');
  for(const change of [{providerAccountId:'other-provider-account-r11'},
   {merchantId:'other-merchant-r11'}, {clientIpAddress:'127.0.0.2'}]){
    const f=fixture({authorityResolver:async({request})=>({...authority(request),...change})});
    assert.equal((await f.flow.authorizeOnce(args(id))).state,'TRUSTED_MAPPING_UNVERIFIED');
    assert.equal(f.calls.transport,0);
    assert.equal(await row(id),null);
  }
});
pgTest('H2: a DECLINED from a foreign intent and attempt stays UNKNOWN_HOLD',async()=>{
  const id=await setup('J');
  const f=fixture({send:async()=>({httpStatus:200,body:{
    status:'DECLINED',tenantId:TENANT,
    paymentIntentId:'foreign-intent-r11',paymentAttemptId:'foreign-attempt-r11'
  }})});
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'UNKNOWN_HOLD_NO_AUTO_RETRY');
  assert.equal((await row(id)).outcome,'UNKNOWN_HOLD');
  assert.equal(f.calls.transport,1);
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'HOLD_NO_AUTO_RETRY');
  assert.equal(f.calls.transport,1);
});
pgTest('H2: a pre-execution rejection carrying a foreign intent stays UNKNOWN',async()=>{
  const id=await setup('K');
  const f=fixture({send:async()=>({httpStatus:422,body:{
    status:'PRE_EXECUTION_FAILED',
    paymentIntentId:'foreign-intent-r11',paymentAttemptId:'foreign-attempt-r11'
  }})});
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'UNKNOWN_HOLD_NO_AUTO_RETRY');
  assert.equal((await row(id)).outcome,'UNKNOWN_HOLD');
});

pgTest('R11 crash/failure inside reservation transaction rolls back BOTH tables, zero POST',async()=>{
 const id=await setup('8'),f=fixture();
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r11_fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id LIKE 'KPR-%8' THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r11_test_insert BEFORE INSERT ON waba_channel.payment_authorization_handoffs FOR EACH ROW EXECUTE FUNCTION waba_channel.r11_fail_test()');
 try{
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'DB_UNAVAILABLE_NO_EFFECT');
  assert.equal(f.calls.transport,0);
  assert.equal(await row(id),null);
  assert.equal(await reserveRow(id),null);
 }finally{
  await pool.query('DROP TRIGGER r11_test_insert ON waba_channel.payment_authorization_handoffs');
  await pool.query('DROP FUNCTION waba_channel.r11_fail_test()');
 }
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'AUTHORIZED_PENDING_CAPTURE_NOT_PAID');
 assert.equal(f.calls.transport,1);
});
pgTest('R11 crash after successful fake Payment POST cannot re-dispatch',async()=>{
 const id=await setup('9'),f=fixture();
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r11_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id LIKE 'KPR-%9' AND NEW.outcome<> 'UNKNOWN_HOLD' THEN RAISE EXCEPTION 'post-dispatch write failure'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r11_test_finalize BEFORE UPDATE ON waba_channel.payment_authorization_handoffs FOR EACH ROW EXECUTE FUNCTION waba_channel.r11_fail_finalize()');
 try{
  assert.equal((await f.flow.authorizeOnce(args(id))).state,'UNKNOWN_HOLD_NO_AUTO_RETRY');
  assert.equal((await row(id)).outcome,'UNKNOWN_HOLD');
  assert.equal(f.calls.transport,1);
 }finally{
  await pool.query('DROP TRIGGER r11_test_finalize ON waba_channel.payment_authorization_handoffs');
  await pool.query('DROP FUNCTION waba_channel.r11_fail_finalize()');
 }
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'HOLD_NO_AUTO_RETRY');
 assert.equal(f.calls.transport,1);
});
pgTest('R11 foreign payer or blocked request cannot start a new financial attempt',async()=>{
 const id=await setup('0'),f=fixture();
 await pool.query('UPDATE waba_channel.requests SET state=$2 WHERE request_id=$1',[id,'BLOCKED']);
 assert.equal((await f.flow.authorizeOnce(args(id))).state,'NOT_FOUND');
 assert.equal(f.calls.transport,0);
});
pgTest('R11 initial database outage is sanitized; no evidence or adapter invoked',async()=>{
 let count=0;
 const f=createR11FencedAuthorization({
  enabled:true,pool:{connect:async()=>{throw Error('SECRET_DATABASE_PASSWORD');},
   query:async()=>{throw Error('SECRET_DATABASE_PASSWORD');}},
  resolveDevice:async()=>{count++;return {};},
  prepareEvidence:{prepare:async()=>{count++;return {};}},
  resolveAuthority:async()=>{count++;return {};},
  adapter:{authorize:async()=>{count++;return {};}}
 });
 assert.deepEqual(await f.authorizeOnce(args(REQUEST('A'))),{state:'DB_UNAVAILABLE_NO_EFFECT'});
 assert.equal(count,0);
});
