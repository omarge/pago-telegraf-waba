'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const protobuf=require('protobufjs');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {TOPIC}=require('../src/businessosR12CanonicalWireGate');
const {recordCoordinate}=require('../src/businessosR12KafkaCommitProcessor');
const {createR12RebalanceFencedConsumer}=
 require('../src/businessosR12RebalanceFencedConsumer');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const t=root.lookupType('businessos.integration.v1.PaymentAuthorized');
const TENANT='r12rb-tenant';
const config={topic:TOPIC,brokers:['secure.kafka.test:9093'],clientId:'r12rb-candidate',
 groupId:'r12rb-offline-group',username:'fake-scram-user',
 password:'offline-testing-secret-123456789'};
let pool;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:16});
  await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r12-kafka-ingress.sql']);
 });
 after(async()=>{await pool.end();});
}
function record(n,offset){
 const intent='r12rb-intent-'+n,attempt='r12rb-attempt-'+n;
 const eventId='payment-engine:'+attempt+':PaymentAuthorized';
 const meta={eventId,eventType:'PaymentAuthorized',eventVersion:1,
  schemaVersion:1,producer:'payment-engine',tenantId:{id:TENANT},
  source:{aggregateType:'Payment',aggregateId:attempt},orderingKey:intent,
  correlationId:intent,causationId:attempt,idempotencyKey:attempt,
  occurredAt:'2026-10-28T22:00:00Z'};
 const message=t.fromObject({meta,paymentId:intent,
  amount:{currency:{code:'MXN'},amountDecimal:'10.00'},
  status:'PAYMENT_STATUS_AUTHORIZED'});
 return {offset:String(offset),key:Buffer.from(TENANT+'|'+intent),
  value:Buffer.from(t.encode(message).finish()),
  headers:{
   'content-type':Buffer.from('application/x-protobuf'),
   'businessos-event-type':Buffer.from('PaymentAuthorized'),
   'businessos-event-id':Buffer.from(eventId),
   'businessos-tenant-id':Buffer.from(TENANT),
   'businessos-schema-version':Buffer.from('1'),
   'businessos-correlation-id':Buffer.from(intent),
   'businessos-causation-id':Buffer.from(attempt),
   'schema-artifact-id':Buffer.from('payment.proto')
  }};
}
function fakeKafka({commitFails=false}={}){
 const state={commits:[],resolved:[],connected:0,stopped:0,opts:null,
  run:null,eachBatch:null,fail:commitFails};
 function factory(opts){
  state.opts=opts;
  return {consumer:co=>{
   state.consumerOptions=co;
   return {
    connect:async()=>{state.connected++;},
    subscribe:async()=>{},
    run:async args=>{state.run=args;state.eachBatch=args.eachBatch;},
    commitOffsets:async offsets=>{
     if(state.fail)throw Error('fake kafka commit failure');
     state.commits.push(offsets);
    },
    stop:async()=>{state.stopped++;},disconnect:async()=>{}
   };
  }};
 }
 function batch(messages,{stale=false,heartbeatFn=null,partition=91}={}){
  const flags={stale,running:true,heartbeats:0};
  const args={
   batch:{topic:TOPIC,partition,messages},
   resolveOffset:o=>{state.resolved.push(o);},
   heartbeat:async()=>{flags.heartbeats++;if(heartbeatFn)await heartbeatFn(flags);},
   isRunning:()=>flags.running,isStale:()=>flags.stale
  };
  return {flags,run:()=>state.eachBatch(args)};
 }
 return {factory,state,batch};
}
function consumer(fk,db=pool){
 return createR12RebalanceFencedConsumer({
  enabled:true,pool:db,config,kafkaFactory:fk.factory});
}
test('R12 rebalance consumer disabled, invalid config, no broker construction',async()=>{
 let calls=0;
 const mock={connect:async()=>{calls++;throw Error('unexpected');},
  query:async()=>{calls++;throw Error('unexpected');}};
 const fake=fakeKafka();
 const disabled=createR12RebalanceFencedConsumer({pool:mock,config,
  kafkaFactory:fake.factory});
 assert.deepEqual(await disabled.start(),{state:'DISABLED'});
 assert.equal(fake.state.connected,0);
 const c=createR12RebalanceFencedConsumer({
  enabled:true,pool:mock,config:{...config,password:''},kafkaFactory:fake.factory});
 assert.deepEqual(await c.start(),{state:'CONFIG_REJECTED_NO_CONNECT'});
 assert.equal(calls,0);assert.equal(fake.state.connected,0);
 assert.equal(disabled.isMountedByWaba,false);
 assert.equal(disabled.isRealBrokerCertified,false);
 assert.equal(disabled.isEconomicDispatcher,false);
});
test('R12 64-bit offset successor must fit broker signed int64',()=>{
 assert.equal(recordCoordinate({topic:TOPIC,partition:0,
  offset:'9223372036854775807'}),null);
 assert.equal(recordCoordinate({topic:TOPIC,partition:0,
  offset:'9223372036854775806'}).nextOffset,'9223372036854775807');
});
pgTest('R12 eachBatch disables auto-commit and acknowledges ONLY persisted offsets',async()=>{
 const fk=fakeKafka(),c=consumer(fk);
 assert.equal((await c.start()).state,
  'REBALANCE_FENCED_CONSUMER_STARTED_CANDIDATES_ONLY');
 assert.equal(fk.state.opts.sasl.mechanism,'scram-sha-512');
 assert.equal(fk.state.opts.ssl.rejectUnauthorized,true);
 assert.equal(fk.state.run.autoCommit,false);
 assert.equal(fk.state.run.eachBatchAutoResolve,false);
 assert.equal(fk.state.run.partitionsConsumedConcurrently,1);
 await fk.batch([record('first',2001),record('second',2003)]).run();
 assert.deepEqual(fk.state.resolved,['2001','2003']);
 assert.deepEqual(fk.state.commits.map(x=>x[0].offset),['2002','2004']);
 const saved=await pool.query('SELECT count(*)::int AS n FROM waba_channel.canonical_kafka_ingress WHERE partition_id=91 AND record_offset IN (2001,2003)');
 assert.equal(saved.rows[0].n,2);
 await c.stop();
});
pgTest('R12 stale partition before processing never writes or commits',async()=>{
 const fk=fakeKafka(),c=consumer(fk);
 await c.start();
 await fk.batch([record('stale',2010)],{stale:true}).run();
 assert.equal(fk.state.commits.length,0);assert.equal(fk.state.resolved.length,0);
 const saved=await pool.query('SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress WHERE partition_id=91 AND record_offset=2010');
 assert.equal(saved.rows[0].n,0);
 await c.stop();
});
pgTest('R12 rebalance becomes stale during heartbeat after DB COMMIT, NO Kafka ACK',async()=>{
 const fk=fakeKafka(),c=consumer(fk);
 await c.start();
 const b=fk.batch([record('stale-after-db',2020)],{
  heartbeatFn:flags=>{flags.stale=true;}
 });
 await b.run();
 assert.equal(b.flags.heartbeats,1);
 assert.equal(fk.state.commits.length,0);assert.equal(fk.state.resolved.length,0);
 const saved=await pool.query('SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress WHERE partition_id=91 AND record_offset=2020');
 assert.equal(saved.rows[0].n,1);
 await c.stop();
});
pgTest('R12 stop during outstanding database operation revokes old callback before commit',async()=>{
 let release,started;
 const begin=new Promise(resolve=>{started=resolve;});
 const gated={query:(...args)=>pool.query(...args),
  connect:async()=>{started();await new Promise(resolve=>{release=resolve;});
   return pool.connect();
  }};
 const fk=fakeKafka(),c=consumer(fk,gated);
 await c.start();
 const task=fk.batch([record('stop-mid-db',2030)]).run();
 await begin;
 await c.stop();
 release();
 await task;
 assert.equal(fk.state.commits.length,0);
 assert.equal(fk.state.resolved.length,0);
 const saved=await pool.query('SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress WHERE partition_id=91 AND record_offset=2030');
 assert.equal(saved.rows[0].n,1);
});
pgTest('R12 invalid second batch event blocks ACK of second, first persisted survives',async()=>{
 const fk=fakeKafka(),c=consumer(fk);
 await c.start();
 const invalid={...record('tamper',2041),headers:{}};
 await assert.rejects(()=>fk.batch([record('good',2040),invalid]).run(),
  /R12_RECORD_HELD_NO_OFFSET_COMMIT/);
 assert.deepEqual(fk.state.commits.map(x=>x[0].offset),['2041']);
 await c.stop();
});
pgTest('R12 decreasing offset in one batch never advances after prior valid record',async()=>{
 const fk=fakeKafka(),c=consumer(fk);
 await c.start();
 await assert.rejects(()=>fk.batch([
  record('ordered',2051),record('reverse',2050)
 ]).run(),/R12_NON_MONOTONIC_OFFSET_HOLD/);
 assert.deepEqual(fk.state.commits.map(x=>x[0].offset),['2052']);
 await c.stop();
});
pgTest('R12 lost Kafka commit ACK replays durable fact without second financial effect',async()=>{
 const fk=fakeKafka({commitFails:true}),c=consumer(fk);
 await c.start();
 const r=record('commit-reset',2060);
 await assert.rejects(()=>fk.batch([r]).run(),/fake kafka commit failure/);
 assert.equal(fk.state.commits.length,0);
 fk.state.fail=false;
 await fk.batch([r]).run();
 assert.deepEqual(fk.state.commits.map(x=>x[0].offset),['2061']);
 const saved=await pool.query('SELECT count(*)::int n FROM waba_channel.canonical_kafka_ingress WHERE partition_id=91 AND record_offset=2060');
 assert.equal(saved.rows[0].n,1);
 await c.stop();
});
