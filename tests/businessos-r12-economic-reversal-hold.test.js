'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createR12EconomicReversalHoldProjection}=
 require('../src/businessosR12EconomicReversalHoldProjection');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const TOPIC='businessos.payment.events.v1',TENANT='waba-r12e-tenant',PAYER='waba-r12e-payer';
let pool,n=0,offset=800000;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:16});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r11-channel.sql',
   'waba-r12-canonical-channel.sql','waba-r12-kafka-ingress.sql']);
 });
 after(async()=>{await pool.end();});
}
const digest=c=>c.repeat(64);
async function setup(outcome='AUTHORIZED_PENDING_CAPTURE'){
 const seq=++n,id='KPR-'+'E'.repeat(24)+seq.toString(16).toUpperCase().padStart(8,'0');
 const intent='r12e-intent-'+seq,attempt='r12e-attempt-'+seq;
 const key='r12e-key-'+seq;
 await pool.query('INSERT INTO waba_channel.requests '+
  '(request_id,requester_wa_id,amount_cents,payer_account_id) VALUES($1,$2,$3,$4)',
  [id,'521555000002',1275,PAYER]);
 await pool.query('INSERT INTO waba_channel.authorization_reservations '+
  '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3)',[id,PAYER,key]);
 await pool.query('INSERT INTO waba_channel.payment_authorization_handoffs '+
  '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
  'amount_cents,idempotency_key,authority_fingerprint,outcome,'+
  'businessos_intent_id,businessos_attempt_id,finalized_at) '+
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $9='UNKNOWN_HOLD' THEN NULL ELSE clock_timestamp() END)",
  [id,PAYER,TENANT,'r12e-customer','11111111-2222-4333-8444-555555555555',
   1275,key,digest('f'),outcome,outcome==='UNKNOWN_HOLD'?null:intent,
   outcome==='UNKNOWN_HOLD'?null:attempt]);
 return {id,intent,attempt};
}
async function event(f,type,{attempt=f.attempt,payload=digest('a'),eventId=null}={}){
 const off=String(++offset),identity=eventId||
  'payment-engine:'+attempt+':'+type;
 await pool.query('INSERT INTO waba_channel.canonical_kafka_ingress '+
  '(event_id,payload_sha256,topic,partition_id,record_offset,event_type,'+
  'tenant_id,payment_intent_id,payment_attempt_id,disposition) '+
  'VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,$9)',
  [identity,payload,TOPIC,off,type,TENANT,f.intent,attempt,
   type==='PaymentCaptured'?'CAPTURE_CANDIDATE_ONLY':'NON_CAPTURE_HOLD']);
 return {eventId:identity,payload};
}
async function capture(f,{payload=digest('a'),cents=1275,attempt=f.attempt}={}){
 const v=await event(f,'PaymentCaptured',{payload,attempt});
 await pool.query('INSERT INTO waba_channel.canonical_capture_candidates '+
  '(event_id,payload_sha256,request_id,tenant_id,payment_intent_id,'+
  'payment_attempt_id,amount_cents,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
  [v.eventId,v.payload,f.id,TENANT,f.intent,attempt,cents,'MXN']);
}
function gate(enabled=true){return createR12EconomicReversalHoldProjection({enabled,pool});}
async function assess(f,accountId=PAYER){return gate().assess({requestId:f.id,accountId});}
test('R12-E disabled by default, malformed selectors do not query DB',async()=>{
 let touched=0;
 const fake={connect:async()=>{touched++;throw Error('forbidden');}};
 const a=createR12EconomicReversalHoldProjection({pool:fake});
 assert.deepEqual(await a.assess({}),{state:'DISABLED',isPaid:false});
 const b=createR12EconomicReversalHoldProjection({pool:fake,enabled:true});
 assert.deepEqual(await b.assess({requestId:'bad',accountId:PAYER}),
  {state:'INVALID',isPaid:false});
 assert.equal(touched,0);assert.equal(a.isFinalityAuthority,false);
 assert.equal(a.isMountedByWaba,false);
});
pgTest('R12-E matching candidate is STILL NOT PAID without verified reconciliation',async()=>{
 const f=await setup();await capture(f);
 const r=await assess(f);
 assert.equal(r.state,'CAPTURE_CANDIDATE_RECONCILIATION_PENDING');
 for(const key of ['isPaid','isFinal','canSendReceipt','canSendWhatsApp',
  'isReconciled','isProviderVerified'])assert.equal(r[key],false,key);
 assert.equal(r.observedEvents,1);
});
pgTest('R12-E another attempt UNKNOWN blocks matched capture candidate',async()=>{
 const f=await setup();await capture(f);
 await event(f,'PaymentExecutionUnknown',{attempt:'foreign-attempt-'+n});
 assert.equal((await assess(f)).state,'REVERSAL_UNKNOWN_OR_FAILURE_HOLD');
});
pgTest('R12-E refund, resolution or failure blocks capture, regardless of event order',async()=>{
 for(const type of ['PaymentRefunded','PaymentExecutionResolved','PaymentFailed']){
  const f=await setup();
  await event(f,type);
  await capture(f);
  const r=await assess(f);
  assert.equal(r.state,'REVERSAL_UNKNOWN_OR_FAILURE_HOLD',type);
  assert.equal(r.isPaid,false);
 }
});
pgTest('R12-E same canonical event ID different digest across offsets is HOLD',async()=>{
 const f=await setup();await capture(f);
 await event(f,'PaymentCaptured',{eventId:'payment-engine:'+f.attempt+':PaymentCaptured',
  payload:digest('b')});
 assert.equal((await assess(f)).state,'CANONICAL_CONFLICT_HOLD');
});
pgTest('R12-E orphan capture candidate, mismatched amount and foreign attempt all HOLD',async()=>{
 const f=await setup();await capture(f,{cents:1276});
 assert.equal((await assess(f)).state,'CAPTURE_EVIDENCE_MISMATCH_HOLD');
 const g=await setup();await capture(g);
 await pool.query('DELETE FROM waba_channel.canonical_kafka_ingress WHERE payment_intent_id=$1',
  [g.intent]);
 assert.equal((await assess(g)).state,'CAPTURE_EVIDENCE_MISMATCH_HOLD');
 const h=await setup();await capture(h,{attempt:'foreign-r12e-attempt'});
 assert.equal((await assess(h)).state,'CAPTURE_EVIDENCE_MISMATCH_HOLD');
});
pgTest('R12-E no candidate, unknown handoff and cross-payer all HOLD',async()=>{
 const f=await setup();
 assert.equal((await assess(f)).state,'CAPTURE_CANDIDATE_MISSING_OR_AMBIGUOUS_HOLD');
 assert.equal((await assess(f,'intruder')).state,'NOT_ELIGIBLE_HOLD');
 const g=await setup('UNKNOWN_HOLD');
 assert.equal((await assess(g)).state,'HANDOFF_NOT_VALID_HOLD');
});
test('R12-E database outage cannot return final or paid',async()=>{
 const projection=createR12EconomicReversalHoldProjection({
  enabled:true,pool:{connect:async()=>{throw Error('private database DSN');}}
 });
 const result=await projection.assess({requestId:'KPR-'+'F'.repeat(32),accountId:PAYER});
 assert.deepEqual(result,{state:'DB_UNAVAILABLE_HOLD',isPaid:false});
});
