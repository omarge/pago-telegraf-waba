'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createR12KafkaHoldJournal}=require('../src/businessosR12KafkaHoldJournal');
const {createR12EconomicReversalHoldProjection}=
 require('../src/businessosR12EconomicReversalHoldProjection');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const tenant='r12fg-tenant',payer='r12fg-payer',intent='r12fg-intent';
const attempt='r12fg-attempt',requestId='KPR-'+'F'.repeat(24)+'00001234';
const topic='businessos.payment.events.v1';
let pool;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:9});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r11-channel.sql',
   'waba-r12-canonical-channel.sql','waba-r12-kafka-ingress.sql',
   'waba-r12-kafka-holds.sql'
  ]);
 });
 after(async()=>{await pool.end();});
}
pgTest('R12-FG real HOLD journal blocks financially clean capture candidate without any Kafka ACK',async()=>{
 const key='r12fg-idempotency-123';
 await pool.query('INSERT INTO waba_channel.requests '+
  '(request_id,requester_wa_id,amount_cents,payer_account_id) VALUES($1,$2,$3,$4)',
  [requestId,'521555000009',1275,payer]);
 await pool.query('INSERT INTO waba_channel.authorization_reservations '+
  '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3)',[requestId,payer,key]);
 await pool.query('INSERT INTO waba_channel.payment_authorization_handoffs '+
  '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
  'amount_cents,idempotency_key,authority_fingerprint,outcome,'+
  'businessos_intent_id,businessos_attempt_id,reserved_businessos_intent_id,'+
  'reserved_businessos_attempt_id,finalized_at) '+
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,'AUTHORIZED_PENDING_CAPTURE',$9,$10,$9,$10,clock_timestamp())",
  [requestId,payer,tenant,'r12fg-customer',
   '11111111-2222-4333-8444-555555555555',1275,key,'d'.repeat(64),intent,attempt]);
 const eventId='payment-engine:'+attempt+':PaymentCaptured';
 const sha='a'.repeat(64);
 await pool.query('INSERT INTO waba_channel.canonical_capture_candidates '+
  '(event_id,payload_sha256,request_id,tenant_id,payment_intent_id,'+
  'payment_attempt_id,amount_cents,currency) VALUES($1,$2,$3,$4,$5,$6,1275,$7)',
  [eventId,sha,requestId,tenant,intent,attempt,'MXN']);
 await pool.query('INSERT INTO waba_channel.canonical_kafka_ingress '+
  '(event_id,payload_sha256,topic,partition_id,record_offset,event_type,'+
  'tenant_id,payment_intent_id,payment_attempt_id,disposition) '+
  "VALUES($1,$2,$3,72,910000,'PaymentCaptured',$4,$5,$6,'CAPTURE_CANDIDATE_ONLY')",
  [eventId,sha,topic,tenant,intent,attempt]);
 const assessor=createR12EconomicReversalHoldProjection({enabled:true,pool});
 const clean=await assessor.assess({requestId,accountId:payer});
 assert.equal(clean.state,'CAPTURE_CANDIDATE_RECONCILIATION_PENDING');
 assert.equal(clean.isPaid,false);
 const journal=createR12KafkaHoldJournal({enabled:true,pool});
 const record={topic,partition:72,message:{offset:'910001',
  key:Buffer.from(tenant+'|'+intent),
  value:Buffer.from('offline-poison-financial-event')}};
 const held=await journal.recordHold({record,reason:'UNVERIFIED_CANONICAL_HOLD'});
 assert.equal(held.state,'DURABLE_HOLD_NO_ACK');assert.equal(held.mayCommit,false);
 const after=await assessor.assess({requestId,accountId:payer});
 assert.equal(after.state,'INCOMPLETE_INGRESS_HOLD');
 assert.equal(after.isPaid,false);assert.equal(after.canSendReceipt,false);
 assert.equal(after.isReconciled,false);
 const repeat=await journal.recordHold({record,reason:'UNVERIFIED_CANONICAL_HOLD'});
 assert.equal(repeat.mayCommit,false);
 assert.equal((await assessor.assess({requestId,accountId:payer})).state,
  'INCOMPLETE_INGRESS_HOLD');
 const check=await pool.query('SELECT observations FROM waba_channel.canonical_kafka_holds '+
  'WHERE topic=$1 AND partition_id=72 AND record_offset=910001',[topic]);
 assert.equal(check.rows[0].observations,2);
});
