'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createR12KafkaHoldJournal,createR12HeldRecordProcessor}=
 require('../src/businessosR12KafkaHoldJournal');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const TOPIC='businessos.payment.events.v1';
let pool;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:15});
  await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r12-kafka-holds.sql']);
 });
 after(async()=>{await pool.end();});
}
function record(offset,bytes=Buffer.from('invalid protobuf secret-containing payload')){
 return {topic:TOPIC,partition:77,
  message:{offset,key:Buffer.from('test-tenant|unknown-payment'),value:bytes}};
}
const reason='UNBOUND_OR_AMBIGUOUS_CAPTURE_HOLD';
const journal=()=>createR12KafkaHoldJournal({pool,enabled:true});
test('HOLD journal default-disabled and invalid inputs cannot touch DB',async()=>{
 let n=0;
 const p={query:async()=>{n++;throw Error('DB MUST NOT BE CALLED');},
  connect:async()=>{n++;throw Error('DB MUST NOT BE CALLED');}};
 const g=createR12KafkaHoldJournal({pool:p});
 assert.deepEqual(await g.recordHold({}),{state:'DISABLED',mayCommit:false});
 assert.deepEqual(await g.listHeld(),{state:'DISABLED'});
 const e=createR12KafkaHoldJournal({pool:p,enabled:true});
 assert.equal((await e.recordHold({record:record('1'),reason:'PAID'})).state,'INVALID_REASON_HOLD');
 assert.equal((await e.recordHold({record:record('1'),reason})).state,'HOLD_DB_UNAVAILABLE_NO_ACK');
 assert.equal((await e.recordHold({record:{...record('3'),topic:'bad'},reason})).state,
  'UNVERIFIABLE_RECORD_HOLD');
 assert.equal((await e.recordHold({record:record('-1'),reason})).state,
  'UNVERIFIABLE_RECORD_HOLD');
 assert.equal((await e.recordHold({record:record('9223372036854775808'),reason})).state,
  'UNVERIFIABLE_RECORD_HOLD');
 assert.equal((await e.recordHold({record:record('9',Buffer.alloc(65537)),reason})).state,
  'UNVERIFIABLE_RECORD_HOLD');
 assert.deepEqual(await e.listHeld({limit:101}),{state:'INVALID'});
 assert.equal(n,1);
 assert.equal(e.isAckSource,false);assert.equal(e.isSkipProcessor,false);
 assert.equal(e.isFinancialDispatcher,false);assert.equal(e.isNotificationDispatcher,false);
});
pgTest('HOLD journal persists only hashes/reason, and repeated observation never ACKs',async()=>{
 const j=journal(),r=record('7001');
 const a=await j.recordHold({record:r,reason});
 const b=await j.recordHold({record:r,reason});
 assert.equal(a.state,'DURABLE_HOLD_NO_ACK');assert.equal(a.mayCommit,false);
 assert.equal(a.canSkip,false);assert.equal(a.canRetryEconomicEffect,false);
 assert.equal(b.state,'DURABLE_HOLD_NO_ACK');
 const q=await pool.query('SELECT * FROM waba_channel.canonical_kafka_holds '+
  'WHERE partition_id=77 AND record_offset=$1',['7001']);
 assert.equal(q.rowCount,1);assert.equal(q.rows[0].observations,2);
 assert.match(q.rows[0].payload_sha256,/^[a-f0-9]{64}$/);
 assert.match(q.rows[0].key_sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(q.rows[0]).includes('secret-containing payload'),false);
 assert.equal(JSON.stringify(q.rows[0]).includes('unknown-payment'),false);
 const listed=await j.listHeld({partition:77,limit:100});
 assert.equal(listed.state,'HOLD_DIAGNOSTICS_READ_ONLY');
 assert.ok(listed.entries.some(x=>x.offset==='7001'&&x.reason===reason&&x.observations===2));
 assert.ok(listed.entries.every(x=>!Object.hasOwn(x,'payload')));
});
pgTest('HOLD journal same offset changed payload or classification stays HOLD no overwrite',async()=>{
 const j=journal(),a=record('7002');
 assert.equal((await j.recordHold({record:a,reason})).state,'DURABLE_HOLD_NO_ACK');
 assert.equal((await j.recordHold({record:record('7002',Buffer.from('different')),reason})).state,
  'HOLD_EVIDENCE_COLLISION');
 assert.equal((await j.recordHold({record:a,reason:'UNVERIFIED_CANONICAL_HOLD'})).state,
  'HOLD_EVIDENCE_COLLISION');
 const saved=await pool.query('SELECT reason,observations FROM '+
  'waba_channel.canonical_kafka_holds WHERE partition_id=77 AND record_offset=$1',['7002']);
 assert.equal(saved.rows[0].reason,reason);
 assert.equal(saved.rows[0].observations,1);
});
pgTest('HOLD journal concurrency never skips or ACKs a blocked delivery',async()=>{
 const j=journal(),args={record:record('7003'),reason};
 const results=await Promise.all(Array.from({length:12},()=>j.recordHold(args)));
 assert.ok(results.every(r=>r.mayCommit===false));
 assert.ok(results.every(r=>['DURABLE_HOLD_NO_ACK','HOLD_RETRY_NO_ACK'].includes(r.state)),
  JSON.stringify(results));
 const found=await pool.query('SELECT count(*)::int n FROM '+
  'waba_channel.canonical_kafka_holds WHERE partition_id=77 AND record_offset=7003');
 assert.equal(found.rows[0].n,1);
});
pgTest('HOLD wrapper preserves success but logs failed processor decision without ACK',async()=>{
 const j=journal();
 const good=createR12HeldRecordProcessor({
  processor:{process:async()=>({state:'NON_CAPTURE_DURABLE_HOLD',mayCommit:true,nextOffset:'7005'})},
  journal:j});
 assert.equal((await good.process(record('7004'))).mayCommit,true);
 const blocked=createR12HeldRecordProcessor({
  processor:{process:async()=>({state:reason,mayCommit:false})},journal:j});
 const result=await blocked.process(record('7005'));
 assert.deepEqual(result,{state:'DURABLE_HOLD_NO_ACK',mayCommit:false});
 const err=createR12HeldRecordProcessor({
  processor:{process:async()=>{throw Error('internal-secret');}},journal:j});
 assert.deepEqual(await err.process(record('7006')),
  {state:'PROCESSOR_UNAVAILABLE_NO_ACK',mayCommit:false});
 const q=await pool.query('SELECT count(*)::int n FROM '+
  'waba_channel.canonical_kafka_holds WHERE partition_id=77 AND record_offset=7005');
 assert.equal(q.rows[0].n,1);
});
