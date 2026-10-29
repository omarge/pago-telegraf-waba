'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const protobuf=require('protobufjs');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {TOPIC,createR12CanonicalWireGate}=require('../src/businessosR12CanonicalWireGate');
const {createR12CanonicalCaptureInbox}=require('../src/businessosR12CanonicalCaptureInbox');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const type=root.lookupType('businessos.integration.v1.PaymentCaptured');
const PAYER='payer-canon-r12',OTHER='other-canon-r12',TENANT='tenant-canon-r12';
let pool,n=0;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:20});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r11-channel.sql','waba-r12-canonical-channel.sql'
  ]);
 });
 after(async()=>{if(pool)await pool.end();});
}
const wireGate=createR12CanonicalWireGate({enabled:true,
 verifyTrustedTransport:async()=>true}); // fake trusted broker in OFFLINE CI only
function wire(intent,attempt,{minor='12.75',tenant=TENANT,occurred='2026-10-28T20:00:00Z'}={}){
 const eventId='payment-engine:'+attempt+':PaymentCaptured';
 const message=type.create({
  meta:{eventId,tenantId:{id:tenant},source:{aggregateType:'Payment',aggregateId:attempt},
   idempotencyKey:attempt,correlationId:intent,causationId:attempt,
   orderingKey:intent,occurredAt:occurred,producer:'payment-engine',
   schemaVersion:1,eventType:'PaymentCaptured',eventVersion:1},
  paymentId:intent,amount:{currency:{code:'MXN'},amountDecimal:minor}
 });
 return {topic:TOPIC,key:Buffer.from(tenant+'|'+intent),
  value:Buffer.from(type.encode(message).finish()),
  headers:{'content-type':'application/x-protobuf',
   'businessos-event-type':'PaymentCaptured',
   'businessos-event-id':eventId,'businessos-tenant-id':tenant,
   'businessos-schema-version':'1','businessos-correlation-id':intent,
   'businessos-causation-id':attempt,'schema-artifact-id':'payment.proto'}
 };
}
async function setup(outcome='AUTHORIZED_PENDING_CAPTURE'){
 const i=++n,id='KPR-'+'C'.repeat(24)+i.toString(16).toUpperCase().padStart(8,'0');
 const intent='waba-int-'+i,attempt='waba-att-'+i,key='waba-r12-canonical-key-'+i;
 await pool.query(
  'INSERT INTO waba_channel.requests (request_id,requester_wa_id,amount_cents,payer_account_id) '+
  'VALUES($1,$2,$3,$4)',[id,'5215555550002',1275,PAYER]);
 await pool.query(
  'INSERT INTO waba_channel.authorization_reservations '+
  '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3)',
  [id,PAYER,key]);
 await pool.query(
  'INSERT INTO waba_channel.payment_authorization_handoffs '+
  '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
  'amount_cents,idempotency_key,authority_fingerprint,outcome,'+
  'businessos_intent_id,businessos_attempt_id,finalized_at) '+
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $9='UNKNOWN_HOLD' THEN NULL ELSE clock_timestamp() END)",
  [id,PAYER,TENANT,'customer-canon-r12',
   '11111111-2222-4333-8444-555555555555',1275,key,'b'.repeat(64),
   outcome,outcome==='UNKNOWN_HOLD'?null:intent,outcome==='UNKNOWN_HOLD'?null:attempt]);
 return {id,intent,attempt,record:wire(intent,attempt)};
}
function inbox(enabled=true,gate=wireGate){
 return createR12CanonicalCaptureInbox({enabled,pool,wireGate:gate});
}
async function count(id){
 const r=await pool.query(
  'SELECT count(*)::int AS n FROM waba_channel.canonical_capture_candidates WHERE request_id=$1',[id]);
 return r.rows[0].n;
}
pgTest('R12 canonical durable candidate is idempotent, never PAID or receipt',async()=>{
 const f=await setup(),o=inbox();
 const a=await o.persistCandidate({requestId:f.id,accountId:PAYER,record:f.record});
 assert.equal(a.state,'STORED_CAPTURE_CANDIDATE_NO_PAID');
 assert.equal(a.isPaid,false);assert.equal(a.canSendReceipt,false);
 const b=await o.persistCandidate({requestId:f.id,accountId:PAYER,record:f.record});
 assert.equal(b.state,'DUPLICATE_CANDIDATE_NO_PAID');
 assert.equal(await count(f.id),1);
 const saved=await pool.query('SELECT evidence_state,amount_cents,currency FROM '+
  'waba_channel.canonical_capture_candidates WHERE request_id=$1',[f.id]);
 assert.equal(saved.rows[0].evidence_state,'CANDIDATE_ONLY');
 assert.equal(Number(saved.rows[0].amount_cents),1275);
 assert.equal(saved.rows[0].currency,'MXN');
});
pgTest('R12 canonical cross-payer, foreign tenant, wrong amount, attempt or UNKNOWN is HOLD',async()=>{
 const f=await setup(),o=inbox();
 const foreign=wire(f.intent,f.attempt,{tenant:'another-tenant'});
 for(const [accountId,record] of [
  [OTHER,f.record],[PAYER,foreign],
  [PAYER,wire(f.intent,f.attempt,{minor:'15.00'})],
  [PAYER,wire('foreign-intent',f.attempt)],
  [PAYER,wire(f.intent,'foreign-attempt')]
 ]){
  const r=await o.persistCandidate({requestId:f.id,accountId,record});
  assert.equal(r.state,'IDENTITY_OR_AMOUNT_MISMATCH_HOLD');
 }
 assert.equal(await count(f.id),0);
 const uncertain=await setup('UNKNOWN_HOLD');
 assert.equal((await o.persistCandidate({
  requestId:uncertain.id,accountId:PAYER,
  record:wire(uncertain.intent,uncertain.attempt)
 })).state,'IDENTITY_OR_AMOUNT_MISMATCH_HOLD');
 assert.equal(await count(uncertain.id),0);
});
pgTest('R12 canonical reused id with changed payload SHA is collision, not duplicate',async()=>{
 const f=await setup(),o=inbox();
 assert.equal((await o.persistCandidate({requestId:f.id,accountId:PAYER,record:f.record})).state,
  'STORED_CAPTURE_CANDIDATE_NO_PAID');
 const changed=wire(f.intent,f.attempt,{occurred:'2026-10-28T21:00:00Z'});
 assert.equal((await o.persistCandidate({requestId:f.id,accountId:PAYER,record:changed})).state,
  'CANDIDATE_ID_COLLISION_HOLD');
 assert.equal(await count(f.id),1);
});
pgTest('R12 canonical 12 concurrent identical intake operations store exactly one candidate',async()=>{
 const f=await setup();
 const all=await Promise.all(Array.from({length:12},()=>inbox().persistCandidate({
  requestId:f.id,accountId:PAYER,record:f.record
 })));
 assert.equal(all.filter(x=>x.state==='STORED_CAPTURE_CANDIDATE_NO_PAID').length,1);
 assert.equal(all.filter(x=>x.state==='DUPLICATE_CANDIDATE_NO_PAID').length,11);
 assert.equal(await count(f.id),1);
});
pgTest('R12 canonical invalid broker headers reject without database mutation',async()=>{
 const f=await setup(),o=inbox();
 const bad={...f.record,headers:{...f.record.headers,'businessos-event-type':'PaymentAuthorized'}};
 assert.equal((await o.persistCandidate({
  requestId:f.id,accountId:PAYER,record:bad
 })).state,'NO_CANONICAL_CAPTURE_HOLD');
 assert.equal(await count(f.id),0);
});
test('R12 canonical gate disabled and DB outage return no effect',async()=>{
 const stub={connect:async()=>{throw Error('SECRET_TEST_DB_HOST');}};
 const disabled=createR12CanonicalCaptureInbox({pool:stub,wireGate});
 assert.deepEqual(await disabled.persistCandidate({}),{state:'DISABLED'});
 const forced=createR12CanonicalCaptureInbox({pool:stub,wireGate,enabled:true});
 const fakeId='KPR-'+'A'.repeat(32);
 const result=await forced.persistCandidate({
  requestId:fakeId,accountId:PAYER,record:wire('waba-int-a','waba-att-a')
 });
 assert.equal(result.state,'DB_UNAVAILABLE_NO_EFFECT');
});

pgTest('R22-A direct inbox: pre-POST reserved identity mismatch and partial reserve never persist capture',async()=>{
 const v=await setup(),p=inbox();
 const reserve=async(intent,attempt)=>pool.query(
  'UPDATE waba_channel.payment_authorization_handoffs '+
  'SET reserved_businessos_intent_id=$1,reserved_businessos_attempt_id=$2 '+
  'WHERE request_id=$3',[intent,attempt,v.id]);
 await reserve('foreign-economic-intent',v.attempt);
 assert.equal((await p.persistCandidate({requestId:v.id,accountId:PAYER,record:v.record})).state,
  'RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD');
 await reserve(v.intent,'foreign-economic-attempt');
 assert.equal((await p.persistCandidate({requestId:v.id,accountId:PAYER,record:v.record})).state,
  'RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD');
 await reserve(v.intent,null);
 assert.equal((await p.persistCandidate({requestId:v.id,accountId:PAYER,record:v.record})).state,
  'RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD');
 assert.equal(await count(v.id),0);
 await reserve(v.intent,v.attempt);
 const ok=await p.persistCandidate({requestId:v.id,accountId:PAYER,record:v.record});
 assert.equal(ok.state,'STORED_CAPTURE_CANDIDATE_NO_PAID');
 assert.equal(ok.isPaid,false);assert.equal(ok.canSendReceipt,false);
});
pgTest('R22-A direct inbox: duplicate tenant+intent handoff blocks even when attempt differs',async()=>{
 const v=await setup(),other=await setup(),p=inbox();
 await pool.query(
  'UPDATE waba_channel.payment_authorization_handoffs '+
  'SET tenant_id=$1,businessos_intent_id=$2 WHERE request_id=$3',
  [TENANT,v.intent,other.id]);
 const result=await p.persistCandidate({requestId:v.id,accountId:PAYER,record:v.record});
 assert.equal(result.state,'AMBIGUOUS_PAYMENT_INTENT_BINDING_HOLD');
 assert.equal(await count(v.id),0);
 await pool.query(
  'UPDATE waba_channel.payment_authorization_handoffs SET tenant_id=$1 WHERE request_id=$2',
  ['other-r22-tenant',other.id]);
 const safe=await p.persistCandidate({requestId:v.id,accountId:PAYER,record:v.record});
 assert.equal(safe.state,'STORED_CAPTURE_CANDIDATE_NO_PAID');
 assert.equal(safe.isPaid,false);assert.equal(safe.canSendReceipt,false);
});
