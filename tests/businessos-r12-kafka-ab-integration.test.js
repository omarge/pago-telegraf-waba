'use strict';
// Integrated R12-A stale-partition + R12-B durable HOLD, offline Kafka only.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Pool}=require('pg');
const protobuf=require('protobufjs');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {TOPIC}=require('../src/businessosR12CanonicalWireGate');
const {createR12RebalanceFencedConsumer}=require('../src/businessosR12RebalanceFencedConsumer');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const T='tenant-r12ab-offline';
const C={brokers:['broker.test.internal:9093'],clientId:'r12ab-client',groupId:'r12ab-group',
 username:'r12ab-user',password:'offline-fake-secret-1234567890',topic:TOPIC};
let pool,serial=0;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:16});
  await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r11-channel.sql',
   'waba-r12-canonical-channel.sql','waba-r12-kafka-ingress.sql','waba-r12-kafka-holds.sql']);
 });
 after(async()=>{await pool.end();});
}
function kafka(){
 const state={eachBatch:null,commits:[],resolved:[],config:null,opts:null};
 return {
  state,
  factory:function FakeKafka(settings){state.config=settings;return {consumer:opts=>{
   state.opts=opts;
   return {
    connect:async()=>{},subscribe:async()=>{},
    run:async args=>{state.eachBatch=args.eachBatch;state.run=args;},
    stop:async()=>{},disconnect:async()=>{},
    commitOffsets:async xs=>{state.commits.push(xs);}
   };
  }};},
  run:async(messages,{stale=false,afterHeartbeat=null,partition=66}={})=>{
   const flags={stale};
   return state.eachBatch({
    batch:{topic:TOPIC,partition,messages},
    isRunning:()=>true,isStale:()=>flags.stale,
    resolveOffset:offset=>state.resolved.push(offset),
    heartbeat:async()=>{if(afterHeartbeat)await afterHeartbeat(flags);}
   });
  }
 };
}
function message(tag,offset,{capture=false,wrongAmount=false}={}){
 const kind=capture?'PaymentCaptured':'PaymentAuthorized';
 const intent='r12ab-intent-'+tag,attempt='r12ab-attempt-'+tag;
 const eventId='payment-engine:'+attempt+':'+kind;
 const meta={eventId,eventType:kind,producer:'payment-engine',
  tenantId:{id:T},source:{aggregateType:'Payment',aggregateId:attempt},
  eventVersion:1,schemaVersion:1,correlationId:intent,causationId:attempt,
  orderingKey:intent,idempotencyKey:attempt,occurredAt:'2026-10-28T22:00:00Z'};
 const type=root.lookupType('businessos.integration.v1.'+kind);
 const wire=type.fromObject({meta,paymentId:intent,
  amount:{currency:{code:'MXN'},amountDecimal:wrongAmount?'99.99':'12.75'},
  ...(capture?{}:{status:'PAYMENT_STATUS_AUTHORIZED'})});
 return {offset:String(offset),value:Buffer.from(type.encode(wire).finish()),
  key:Buffer.from(T+'|'+intent),headers:{
   'content-type':Buffer.from('application/x-protobuf'),
   'businessos-event-type':Buffer.from(kind),
   'businessos-event-id':Buffer.from(eventId),
   'businessos-tenant-id':Buffer.from(T),
   'businessos-schema-version':Buffer.from('1'),
   'businessos-correlation-id':Buffer.from(intent),
   'businessos-causation-id':Buffer.from(attempt),
   'schema-artifact-id':Buffer.from('payment.proto')
  }};
}
async function holdAt(offset){
 const r=await pool.query('SELECT reason,observations,payload_sha256,key_sha256 '+
  'FROM waba_channel.canonical_kafka_holds WHERE topic=$1 AND partition_id=$2 AND record_offset=$3',
  [TOPIC,66,String(offset)]);
 return r.rows;
}
async function ingressAt(offset){
 const r=await pool.query('SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress '+
  'WHERE topic=$1 AND partition_id=$2 AND record_offset=$3',
  [TOPIC,66,String(offset)]);
 return r.rows[0].n;
}
function consumer(fake,db=pool){
 return createR12RebalanceFencedConsumer({enabled:true,pool:db,config:C,kafkaFactory:fake.factory});
}
test('R12-AB disabled by default never creates broker or touches database',async()=>{
 const p={connect:async()=>{throw Error('unexpected');},query:async()=>{throw Error('unexpected');}};
 let calls=0;
 const c=createR12RebalanceFencedConsumer({pool:p,config:C,
  kafkaFactory:()=>{calls++;throw Error('should not reach Kafka');}});
 assert.deepEqual(await c.start(),{state:'DISABLED'});
 assert.equal(calls,0);
 assert.equal(c.isRealBrokerCertified,false);assert.equal(c.isEconomicDispatcher,false);
});
pgTest('R12-AB malformed economic event is a durable HOLD with zero offset ACK',async()=>{
 const f=kafka(),c=consumer(f);assert.equal((await c.start()).state,
  'REBALANCE_FENCED_CONSUMER_STARTED_CANDIDATES_ONLY');
 const n=700001,invalid=message('invalid-a',n);
 invalid.headers['businessos-event-id']=Buffer.from('attacker-fraudulent');
 await assert.rejects(()=>f.run([invalid]),/RECORD_HELD_NO_OFFSET_COMMIT/);
 assert.equal(f.state.commits.length,0);
 assert.equal(f.state.resolved.length,0);
 assert.equal(await ingressAt(n),0);
 const rows=await holdAt(n);
 assert.equal(rows.length,1);assert.equal(rows[0].reason,'UNVERIFIED_CANONICAL_HOLD');
 assert.match(rows[0].payload_sha256,/^[a-f0-9]{64}$/);
 assert.match(rows[0].key_sha256,/^[a-f0-9]{64}$/);
 const listing=await c.listHeld({partition:66});
 assert.equal(listing.state,'HOLD_DIAGNOSTICS_READ_ONLY');
 assert.ok(listing.entries.some(r=>r.offset===String(n)&&r.reason==='UNVERIFIED_CANONICAL_HOLD'));
 assert.ok(listing.entries.every(r=>!('payload' in r)));
 await c.stop();
});
pgTest('R12-AB same held delivery replay after consumer restart preserves one immutable truth',async()=>{
 const f1=kafka(),a=consumer(f1);await a.start();
 const n=700002,record=message('invalid-b',n);
 record.headers['businessos-event-type']=Buffer.from('UnauthorizedCaptured');
 await assert.rejects(()=>f1.run([record]),/RECORD_HELD_NO_OFFSET_COMMIT/);
 await a.stop();
 const f2=kafka(),b=consumer(f2);await b.start();
 await assert.rejects(()=>f2.run([record]),/RECORD_HELD_NO_OFFSET_COMMIT/);
 assert.equal(f1.state.commits.length+f2.state.commits.length,0);
 const rows=await holdAt(n);assert.equal(rows.length,1);assert.equal(rows[0].observations,2);
 await b.stop();
});
pgTest('R12-AB good noncapture followed by bad event ACKs only first and holds second',async()=>{
 const f=kafka(),c=consumer(f);await c.start();
 const first=message('good',700003),second=message('bad-after-good',700004);
 second.headers['businessos-tenant-id']=Buffer.from('tenant-intruder');
 await assert.rejects(()=>f.run([first,second]),/RECORD_HELD_NO_OFFSET_COMMIT/);
 assert.deepEqual(f.state.resolved,['700003']);
 assert.deepEqual(f.state.commits.map(x=>x[0].offset),['700004']);
 assert.equal(await ingressAt(700003),1);assert.equal(await ingressAt(700004),0);
 const rows=await holdAt(700004);
 assert.equal(rows.length,1);assert.equal(rows[0].reason,'UNVERIFIED_CANONICAL_HOLD');
 await c.stop();
});
pgTest('R12-AB unbound PaymentCaptured is held and never creates candidate or ACK',async()=>{
 const f=kafka(),c=consumer(f);await c.start();
 const n=700005;
 await assert.rejects(()=>f.run([message('unbound',n,{capture:true})]),
  /RECORD_HELD_NO_OFFSET_COMMIT/);
 assert.equal(f.state.commits.length,0);
 const holds=await holdAt(n);assert.equal(holds.length,1);
 assert.equal(holds[0].reason,'UNBOUND_OR_AMBIGUOUS_CAPTURE_HOLD');
 const economic=await pool.query('SELECT count(*)::int n FROM waba_channel.canonical_capture_candidates '+
  "WHERE payment_intent_id='r12ab-intent-unbound'");
 assert.equal(economic.rows[0].n,0);
 await c.stop();
});
pgTest('R12-AB wrong payload at same held offset never overwrites first evidence',async()=>{
 const f=kafka(),c=consumer(f);await c.start();
 const n=700006,a=message('collision-a',n),b=message('collision-b',n);
 a.headers['businessos-event-id']=Buffer.from('bad-a');
 b.headers['businessos-event-id']=Buffer.from('bad-b');
 await assert.rejects(()=>f.run([a]),/RECORD_HELD_NO_OFFSET_COMMIT/);
 await assert.rejects(()=>f.run([b]),/RECORD_HELD_NO_OFFSET_COMMIT/);
 assert.equal(f.state.commits.length,0);
 const rows=await holdAt(n);assert.equal(rows.length,1);assert.equal(rows[0].observations,1);
 await c.stop();
});
pgTest('R12-AB HOLD DB failure never advances Kafka offset or silently acknowledges poison',async()=>{
 const n=700007,f=kafka();
 // Use legitimate PG for source and audit, inject failure on the HOLD INSERT.
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r12ab_fail_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.record_offset=700007 THEN RAISE EXCEPTION 'offline only'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r12ab_fail_hold BEFORE INSERT ON waba_channel.canonical_kafka_holds '+
  'FOR EACH ROW EXECUTE FUNCTION waba_channel.r12ab_fail_hold()');
 const c=consumer(f);await c.start();
 try{
  const bad=message('db-failed',n);
  bad.headers['businessos-event-id']=Buffer.from('bad');
  await assert.rejects(()=>f.run([bad]),/RECORD_HELD_NO_OFFSET_COMMIT/);
  assert.equal(f.state.commits.length,0);assert.equal(await ingressAt(n),0);
  assert.deepEqual(await holdAt(n),[]);
 }finally{
  await pool.query('DROP TRIGGER r12ab_fail_hold ON waba_channel.canonical_kafka_holds');
  await pool.query('DROP FUNCTION waba_channel.r12ab_fail_hold()');
  await c.stop();
 }
});
pgTest('R12-AB rebalance stale at heartbeat does not offset commit even for durable HOLD-safe event',async()=>{
 const n=700008,f=kafka(),c=consumer(f);await c.start();
 await f.run([message('stale-ack',n)],{afterHeartbeat:flags=>{flags.stale=true;}});
 assert.equal(await ingressAt(n),1);
 assert.equal(f.state.commits.length,0);assert.equal(f.state.resolved.length,0);
 assert.deepEqual(await holdAt(n),[]);
 await c.stop();
});
