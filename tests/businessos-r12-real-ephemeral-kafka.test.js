'use strict';
// R12-D: REAL throwaway Apache Kafka broker and PostgreSQL 18 CI ONLY.
// The transport-override factory is a test fixture for plaintext localhost,
// NEVER a deployable replacement for SCRAM/TLS/ACL requirements.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Kafka}=require('kafkajs');
const {Pool}=require('pg');
const protobuf=require('protobufjs');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createR12RebalanceFencedConsumer}=
 require('../src/businessosR12RebalanceFencedConsumer');
const {TOPIC}=require('../src/businessosR12CanonicalWireGate');
const {createR12EconomicReversalHoldProjection}=
 require('../src/businessosR12EconomicReversalHoldProjection');
const enable=process.env.R12_D_EPHEMERAL_KAFKA==='1'&&!!process.env.R4_POSTGRES_TEST_URL;
const brokerTest=enable?test:test.skip;
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const eventType=root.lookupType('businessos.integration.v1.PaymentAuthorized');
const tenant='tenant-r12d-ephemeral',intent='r12d-intent-0001';
const attempt='r12d-attempt-0001';
const eventId='payment-engine:'+attempt+':PaymentAuthorized';
function encoded(){
 const msg=eventType.fromObject({
  meta:{eventId,eventType:'PaymentAuthorized',eventVersion:1,schemaVersion:1,
   tenantId:{id:tenant},producer:'payment-engine',
   source:{aggregateType:'Payment',aggregateId:attempt},
   idempotencyKey:attempt,correlationId:intent,causationId:attempt,
   orderingKey:intent,occurredAt:'2026-10-28T22:22:22Z'},
  paymentId:intent,amount:{currency:{code:'MXN'},amountDecimal:'12.75'},
  status:'PAYMENT_STATUS_AUTHORIZED'
 });
 const headers={
  'content-type':'application/x-protobuf',
  'businessos-event-type':'PaymentAuthorized',
  'businessos-event-id':eventId,
  'businessos-tenant-id':tenant,
  'businessos-schema-version':'1',
  'businessos-correlation-id':intent,
  'businessos-causation-id':attempt,
  'schema-artifact-id':'payment.proto'
 };
 return {key:tenant+'|'+intent,value:Buffer.from(eventType.encode(msg).finish()),headers};
}
function economicWire(kind){
 const type=root.lookupType('businessos.integration.v1.'+kind);
 const economicEventId='payment-engine:'+attempt+':'+kind;
 const data={meta:{eventId:economicEventId,eventType:kind,
  eventVersion:1,schemaVersion:1,tenantId:{id:tenant},
  producer:'payment-engine',source:{aggregateType:'Payment',aggregateId:attempt},
  idempotencyKey:attempt,correlationId:intent,causationId:attempt,
  orderingKey:intent,occurredAt:'2026-10-28T22:23:33Z'},
  paymentId:intent,
  amount:{currency:{code:'MXN'},amountDecimal:'12.75'}};
 if(kind==='PaymentRefunded')data.refundId='offline-refund-fixture';
 return {key:tenant+'|'+intent,
  value:Buffer.from(type.encode(type.fromObject(data)).finish()),
  headers:{
   'content-type':'application/x-protobuf',
   'businessos-event-type':kind,
   'businessos-event-id':economicEventId,
   'businessos-tenant-id':tenant,
   'businessos-schema-version':'1',
   'businessos-correlation-id':intent,
   'businessos-causation-id':attempt,
   'schema-artifact-id':'payment.proto'
  }};
}
async function eventually(fn,{attempts=90,interval=300}={}){
 for(let i=0;i<attempts;i++){
  const result=await fn();
  if(result)return result;
  await new Promise(resolve=>setTimeout(resolve,interval));
 }
 throw Error('R12_REAL_BROKER_ASSERTION_TIMEOUT');
}
brokerTest('R12-D real ephemeral Kafka broker + PostgreSQL18: two wire deliveries and durable offsets, no payments',async()=>{
 const pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:10});
 const raw=new Kafka({clientId:'r12d-test-producer',brokers:['127.0.0.1:9092'],
  connectionTimeout:2500,retry:{retries:5}});
 const admin=raw.admin(),producer=raw.producer({allowAutoTopicCreation:false});
 let consumer;
 try{
  await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r11-channel.sql',
   'waba-r12-canonical-channel.sql','waba-r12-kafka-ingress.sql',
   'waba-r12-kafka-holds.sql']);
  const requestId='KPR-'+'B'.repeat(32),payer='r12de-payer',key='r12de-offline-key';
  await pool.query('INSERT INTO waba_channel.requests '+
   '(request_id,requester_wa_id,amount_cents,payer_account_id) VALUES($1,$2,$3,$4)',
   [requestId,'521555000003',1275,payer]);
  await pool.query('INSERT INTO waba_channel.authorization_reservations '+
   '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3)',
   [requestId,payer,key]);
  await pool.query('INSERT INTO waba_channel.payment_authorization_handoffs '+
   '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
   'amount_cents,idempotency_key,authority_fingerprint,outcome,'+
   'businessos_intent_id,businessos_attempt_id,finalized_at) '+
   "VALUES($1,$2,$3,$4,$5,$6,$7,$8,'AUTHORIZED_PENDING_CAPTURE',$9,$10,clock_timestamp())",
   [requestId,payer,tenant,'r12de-customer',
    '11111111-2222-4333-8444-555555555555',1275,key,'c'.repeat(64),
    intent,attempt]);
  await eventually(async()=>{
   try{await admin.connect();return true;}catch(_e){return false;}
  });
  await admin.createTopics({topics:[{topic:TOPIC,numPartitions:1,replicationFactor:1}],
   waitForLeaders:true});
  await producer.connect();
  // This is the only permitted plaintext override: an isolated CI fixture.
  // Production adapter STILL requests TLS + SCRAM and remains UNMOUNTED.
  function PlaintextEphemeralKafkaFactory(_secureConfig){
   return new Kafka({clientId:'r12d-kafka-wire-ci',
    brokers:['127.0.0.1:9092'],connectionTimeout:3000,retry:{retries:3}});
  }
  consumer=createR12RebalanceFencedConsumer({
   enabled:true,pool,
   config:{topic:TOPIC,brokers:['ephemeral-ci.invalid:9093'],
    clientId:'r12d-secure-shell',groupId:'r12d-unique-group',
    username:'fixture-only',password:'never-a-real-broker-password'},
   kafkaFactory:PlaintextEphemeralKafkaFactory
  });
  const started=await consumer.start();
  assert.equal(started.state,'REBALANCE_FENCED_CONSUMER_STARTED_CANDIDATES_ONLY');
  // Wait for group assignment; use actual topic metadata & group membership.
  await eventually(async()=>{
   const groups=await admin.describeGroups(['r12d-unique-group']);
   const g=groups.groups[0];
   return g?.state==='Stable'&&g.members?.length===1;
  });
  const fact=encoded();
  await producer.send({topic:TOPIC,messages:[fact]});
  await eventually(async()=>{
   const rows=await pool.query("SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress "+
    "WHERE event_id=$1",[eventId]);
   return rows.rows[0].n===1;
  });
  await producer.send({topic:TOPIC,messages:[fact]});
  await eventually(async()=>{
   const rows=await pool.query("SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress "+
    "WHERE event_id=$1",[eventId]);
   return rows.rows[0].n===2;
  });
  const evidence=await pool.query(
   'SELECT event_id,payload_sha256,disposition,record_offset,partition_id '+
   'FROM waba_channel.canonical_kafka_ingress WHERE event_id=$1 ORDER BY record_offset',[eventId]);
  assert.equal(evidence.rowCount,2);
  assert.equal(evidence.rows[0].payload_sha256,evidence.rows[1].payload_sha256);
  assert.deepEqual(evidence.rows.map(r=>r.disposition),['NON_CAPTURE_HOLD','NON_CAPTURE_HOLD']);
  assert.deepEqual(evidence.rows.map(r=>String(r.record_offset)),['0','1']);
  assert.deepEqual(evidence.rows.map(r=>r.partition_id),[0,0]);
  // The captured fact is a CANDIDATE, never PAID, even over real Kafka.
  const projection=createR12EconomicReversalHoldProjection({enabled:true,pool});
  await producer.send({topic:TOPIC,messages:[economicWire('PaymentCaptured')]});
  await eventually(async()=>{
   const r=await pool.query(
    'SELECT count(*)::int n FROM waba_channel.canonical_capture_candidates '+
    'WHERE request_id=$1',[requestId]);
   return r.rows[0].n===1;
  });
  const beforeRefund=await projection.assess({requestId,accountId:payer});
  assert.equal(beforeRefund.state,'CAPTURE_CANDIDATE_RECONCILIATION_PENDING');
  assert.equal(beforeRefund.isPaid,false);
  assert.equal(beforeRefund.canSendReceipt,false);
  await producer.send({topic:TOPIC,messages:[economicWire('PaymentRefunded')]});
  await eventually(async()=>{
   const r=await pool.query(
    'SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress '+
    "WHERE event_type='PaymentRefunded' AND payment_intent_id=$1",[intent]);
   return r.rows[0].n===1;
  });
  const afterRefund=await projection.assess({requestId,accountId:payer});
  assert.equal(afterRefund.state,'REVERSAL_UNKNOWN_OR_FAILURE_HOLD');
  assert.equal(afterRefund.isPaid,false);
  assert.equal(afterRefund.canSendReceipt,false);
  const candidate=await pool.query(
   'SELECT evidence_state FROM waba_channel.canonical_capture_candidates '+
   'WHERE request_id=$1',[requestId]);
  assert.equal(candidate.rows[0].evidence_state,'CANDIDATE_ONLY');
  assert.equal(consumer.isEconomicDispatcher,false);
  assert.equal(consumer.isMetaDispatcher,false);
  assert.equal(consumer.isCaptureCertified,false);
 }finally{
  if(consumer)await consumer.stop();
  try{await producer.disconnect();}catch(_e){}
  try{await admin.disconnect();}catch(_e){}
  await pool.end();
 }
});
