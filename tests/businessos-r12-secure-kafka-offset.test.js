'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Pool}=require('pg');
const protobuf=require('protobufjs');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {TOPIC}=require('../src/businessosR12CanonicalWireGate');
const {createR12SecuredKafkaConsumer,validateSecureKafkaConfig}=
 require('../src/businessosR12SecuredKafkaConsumer');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const PAYER='waba-r12k-payer',TENANT='waba-r12k-tenant';
const cfg=()=>({topic:TOPIC,brokers:['broker.test.internal:9093'],
 clientId:'waba-r12k-offline',groupId:'waba-r12k-offline-consumer',
 username:'waba-r12k-scram',password:'test-secret-only-not-live-123456789'});
let pool,serial=0;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:18});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r11-channel.sql',
   'waba-r12-canonical-channel.sql','waba-r12-kafka-ingress.sql']);
 });
 after(async()=>{if(pool)await pool.end();});
}
function record(intent,attempt,{type='PaymentCaptured',date='2026-10-28T21:00:00Z',
 amount='12.75',tenant=TENANT,offset='7'}={}){
 const eventId='payment-engine:'+attempt+':'+type;
 const t=root.lookupType('businessos.integration.v1.'+type);
 const meta={eventId,eventType:type,eventVersion:1,schemaVersion:1,
  producer:'payment-engine',tenantId:{id:tenant},source:{
   aggregateType:'Payment',aggregateId:attempt
  },idempotencyKey:attempt,correlationId:intent,causationId:attempt,
  orderingKey:intent,occurredAt:date};
 const message={meta,paymentId:intent,amount:{currency:{code:'MXN'},amountDecimal:amount}};
 if(type==='PaymentAuthorized')message.status='PAYMENT_STATUS_AUTHORIZED';
 if(type==='PaymentExecutionUnknown'){
  message.paymentAttemptId=attempt;message.status='OUTCOME_STATUS_UNKNOWN';
 }
 const value=Buffer.from(t.encode(t.fromObject(message)).finish());
 const headers={
  'content-type':Buffer.from('application/x-protobuf'),
  'businessos-event-type':Buffer.from(type),
  'businessos-event-id':Buffer.from(eventId),
  'businessos-tenant-id':Buffer.from(tenant),
  'businessos-schema-version':Buffer.from('1'),
  'businessos-correlation-id':Buffer.from(intent),
  'businessos-causation-id':Buffer.from(attempt),
  'schema-artifact-id':Buffer.from('payment.proto')
 };
 return {topic:TOPIC,partition:0,message:{
  offset,key:Buffer.from(tenant+'|'+intent),value,headers
 }};
}
function fakeKafka({failConnect=false}={}){
 const state={connected:0,stopped:0,disconnected:0,commits:[],settings:null,
  subscription:null,callback:null,run:null};
 function factory(options){
  state.settings=options;
  return {consumer(opts){
   state.consumerOptions=opts;
   return {
    connect:async()=>{state.connected++;if(failConnect)throw Error('fake password private');},
    subscribe:async data=>{state.subscription=data;},
    run:async data=>{state.callback=data.eachMessage;state.run=data;},
    commitOffsets:async data=>{state.commits.push(data);},
    stop:async()=>{state.stopped++;},
    disconnect:async()=>{state.disconnected++;}
   };
  }};
 }
 return {factory,state};
}
async function setup(){
 const n=++serial,requestId='KPR-'+'D'.repeat(24)+n.toString(16).toUpperCase().padStart(8,'0');
 const intent='waba-int-r12k-'+n,attempt='waba-att-r12k-'+n,key='waba-r12k-'+n;
 await pool.query('INSERT INTO waba_channel.requests '+
  '(request_id,requester_wa_id,amount_cents,payer_account_id) VALUES($1,$2,$3,$4)',
  [requestId,'5215555550002',1275,PAYER]);
 await pool.query('INSERT INTO waba_channel.authorization_reservations '+
  '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3)',[requestId,PAYER,key]);
 await pool.query('INSERT INTO waba_channel.payment_authorization_handoffs '+
  '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
  'amount_cents,idempotency_key,authority_fingerprint,outcome,'+
  'businessos_intent_id,businessos_attempt_id,finalized_at) '+
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,'AUTHORIZED_PENDING_CAPTURE',$9,$10,clock_timestamp())",
  [requestId,PAYER,TENANT,'customer-r12k',
   '11111111-2222-4333-8444-555555555555',1275,key,'e'.repeat(64),intent,attempt]);
 return {requestId,intent,attempt};
}
async function count(table,requestId=null){
 const sql=table==='canonical_capture_candidates'?
  'SELECT count(*)::int n FROM waba_channel.canonical_capture_candidates WHERE request_id=$1':
  'SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress';
 const r=await pool.query(sql,table==='canonical_capture_candidates'?[requestId]:[]);
 return r.rows[0].n;
}
test('R12 Kafka refuses any insecure/incomplete SCRAM configuration before connection',async()=>{
 const options=[
  {...cfg(),brokers:[]},{...cfg(),brokers:['http://localhost:9092']},
  {...cfg(),username:''},{...cfg(),password:'short'},
  {...cfg(),topic:'arbitrary.payments'},{...cfg(),groupId:''},
  {...cfg(),clientId:''}
 ];
 for(const c of options)assert.equal(validateSecureKafkaConfig(c),false);
 assert.equal(validateSecureKafkaConfig(cfg()),true);
 let touched=0;
 const stub={connect:async()=>{touched++;throw Error('no database');},
  query:async()=>{touched++;throw Error('no database');}};
 const fake=fakeKafka();
 const disabled=createR12SecuredKafkaConsumer({pool:stub,config:cfg(),kafkaFactory:fake.factory});
 assert.deepEqual(await disabled.start(),{state:'DISABLED'});
 assert.equal(fake.state.connected,0);
 for(const c of options){
  const r=createR12SecuredKafkaConsumer({
   enabled:true,pool:stub,config:c,kafkaFactory:fake.factory
  });
  assert.deepEqual(await r.start(),{state:'CONFIG_REJECTED_NO_CONNECT'});
 }
 assert.equal(touched,0);assert.equal(fake.state.connected,0);
 assert.equal(disabled.isMountedByWaba,false);
 assert.equal(disabled.isFinancialDispatcher,false);
 assert.equal(disabled.isMetaDispatcher,false);
});
test('R12 Kafka CONNECT failure never enables an offset/financial side effect',async()=>{
 const fake=fakeKafka({failConnect:true});
 const c=createR12SecuredKafkaConsumer({enabled:true,pool:{
  connect:async()=>{throw Error('no database');},
  query:async()=>{throw Error('no database');}
 },config:cfg(),kafkaFactory:fake.factory});
 assert.deepEqual(await c.start(),{state:'KAFKA_CONNECT_OR_RUN_FAILED_NO_EFFECT'});
 assert.equal(fake.state.commits.length,0);assert.equal(fake.state.disconnected,1);
});
pgTest('R12 Kafka authenticated adapter candidate commits offset AFTER two durable rows',async()=>{
 const f=await setup(),fake=fakeKafka(),c=createR12SecuredKafkaConsumer({
  enabled:true,pool,config:cfg(),kafkaFactory:fake.factory});
 assert.deepEqual(await c.start(),{state:'CONSUMER_STARTED_CANDIDATES_ONLY'});
 assert.equal(fake.state.settings.ssl.rejectUnauthorized,true);
 assert.equal(fake.state.settings.sasl.mechanism,'scram-sha-512');
 assert.equal(fake.state.consumerOptions.allowAutoTopicCreation,false);
 assert.equal(fake.state.run.autoCommit,false);
 assert.equal(fake.state.run.partitionsConsumedConcurrently,1);
 assert.equal(fake.state.subscription.topic,TOPIC);
 const item=record(f.intent,f.attempt,{offset:'9223372036854775806'});
 await fake.state.callback(item);
 assert.deepEqual(fake.state.commits,[[{
  topic:TOPIC,partition:0,offset:'9223372036854775807'
 }]]);
 assert.equal(await count('canonical_capture_candidates',f.requestId),1);
 const found=await pool.query(
  'SELECT disposition FROM waba_channel.canonical_kafka_ingress WHERE payment_attempt_id=$1',
  [f.attempt]);
 assert.equal(found.rowCount,1);
 assert.equal(found.rows[0].disposition,'CAPTURE_CANDIDATE_ONLY');
 await c.stop();
});
pgTest('R12 Kafka replay same offset and same event at new offset both safely commit once DB durable',async()=>{
 const f=await setup(),fake=fakeKafka(),c=createR12SecuredKafkaConsumer({
  enabled:true,pool,config:cfg(),kafkaFactory:fake.factory});
 await c.start();
 const base=record(f.intent,f.attempt,{offset:'110'});
 await fake.state.callback(base);
 await fake.state.callback(base);
 await fake.state.callback(record(f.intent,f.attempt,{offset:'111'}));
 assert.equal(fake.state.commits.length,3);
 assert.deepEqual(fake.state.commits.map(x=>x[0].offset),['111','111','112']);
 assert.equal(await count('canonical_capture_candidates',f.requestId),1);
 const saved=await pool.query(
  'SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress WHERE payment_attempt_id=$1',
  [f.attempt]);
 assert.equal(saved.rows[0].n,2);
 await c.stop();
});
pgTest('R12 Kafka same event_id with modified payload at new offset is HOLD, no offset commit',async()=>{
 const f=await setup(),fake=fakeKafka(),c=createR12SecuredKafkaConsumer({
  enabled:true,pool,config:cfg(),kafkaFactory:fake.factory});
 await c.start();
 await fake.state.callback(record(f.intent,f.attempt,{offset:'120'}));
 await assert.rejects(()=>fake.state.callback(record(f.intent,f.attempt,{
  offset:'121',date:'2026-10-28T22:00:00Z'
 })),/HELD_NO_OFFSET_COMMIT/);
 assert.equal(fake.state.commits.length,1);
 assert.equal(await count('canonical_capture_candidates',f.requestId),1);
 await c.stop();
});
pgTest('R12 Kafka authorized/unknown events durably audit but never mark paid',async()=>{
 const f=await setup(),fake=fakeKafka(),c=createR12SecuredKafkaConsumer({
  enabled:true,pool,config:cfg(),kafkaFactory:fake.factory});
 await c.start();
 await fake.state.callback(record(f.intent,f.attempt,{
  type:'PaymentAuthorized',offset:'130'
 }));
 await fake.state.callback(record(f.intent,f.attempt,{
  type:'PaymentExecutionUnknown',offset:'131'
 }));
 assert.deepEqual(fake.state.commits.map(x=>x[0].offset),['131','132']);
 assert.equal(await count('canonical_capture_candidates',f.requestId),0);
 const r=await pool.query('SELECT disposition FROM waba_channel.canonical_kafka_ingress '+
  'WHERE payment_attempt_id=$1 ORDER BY record_offset',[f.attempt]);
 assert.deepEqual(r.rows.map(x=>x.disposition),['NON_CAPTURE_HOLD','NON_CAPTURE_HOLD']);
 await c.stop();
});
pgTest('R12 Kafka foreign/unbound capture and tampered header HOLD with no offset advancement',async()=>{
 const f=await setup(),fake=fakeKafka(),c=createR12SecuredKafkaConsumer({
  enabled:true,pool,config:cfg(),kafkaFactory:fake.factory});
 await c.start();
 await assert.rejects(()=>fake.state.callback(record('foreign-intent','foreign-attempt',{offset:'140'})),
  /HELD_NO_OFFSET_COMMIT/);
 const forgery=record(f.intent,f.attempt,{offset:'141'});
 forgery.message.headers['businessos-tenant-id']=Buffer.from('foreign');
 await assert.rejects(()=>fake.state.callback(forgery),/HELD_NO_OFFSET_COMMIT/);
 assert.equal(fake.state.commits.length,0);
 await c.stop();
});
pgTest('R12 Kafka crash after candidate commit before audit replays safely without duplicate capture',async()=>{
 const f=await setup(),fake=fakeKafka(),c=createR12SecuredKafkaConsumer({
  enabled:true,pool,config:cfg(),kafkaFactory:fake.factory});
 await c.start();
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r12k_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payment_attempt_id='"+
  f.attempt+"' THEN RAISE EXCEPTION 'offline audit crash'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r12k_test_abort BEFORE INSERT ON waba_channel.canonical_kafka_ingress FOR EACH ROW EXECUTE FUNCTION waba_channel.r12k_test_fail()');
 const item=record(f.intent,f.attempt,{offset:'150'});
 try{
  await assert.rejects(()=>fake.state.callback(item),/HELD_NO_OFFSET_COMMIT/);
  assert.equal(fake.state.commits.length,0);
  assert.equal(await count('canonical_capture_candidates',f.requestId),1);
 }finally{
  await pool.query('DROP TRIGGER r12k_test_abort ON waba_channel.canonical_kafka_ingress');
  await pool.query('DROP FUNCTION waba_channel.r12k_test_fail()');
 }
 await fake.state.callback(item);
 assert.equal(fake.state.commits.length,1);
 assert.equal(await count('canonical_capture_candidates',f.requestId),1);
 await c.stop();
});
