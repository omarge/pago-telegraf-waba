'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createPgSignedInbox}=require('../src/businessosPgSignedInbox');
const {createR11OfflineInboundPipeline}=require('../src/businessosR11OfflineInboundPipeline');
const {createPgSafeMenuOutbox,keyFor}=require('../src/businessosPgSafeMenuOutbox');
const KEY=crypto.createHash('sha256').update('r11-pipeline-offline-ci-key').digest();
const SECRET='r11-pipeline-meta-app-secret-only-for-ci-0000';
const PHONE='1478834131971433',FROM='5215555550002';
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const sign=v=>'sha256='+crypto.createHmac('sha256',SECRET).update(v).digest('hex');
const event=(id,body='menu',type='MESSAGE')=>{
 const value={metadata:{phone_number_id:PHONE}};
 if(type==='MESSAGE')value.messages=[{id,from:FROM,type:'text',text:{body}}];
 else value.statuses=[{id,status:'delivered',timestamp:'1800000000',recipient_id:FROM}];
 return Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[
  {changes:[{field:'messages',value}]}]}));
};
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
let pool,ingress,pipeline;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:25});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r5-channel.sql','waba-r6-channel.sql',
   'waba-r7-channel.sql','waba-r8-channel.sql']);
  ingress=createPgSignedInbox({pool,appSecret:SECRET,encryptionKey:KEY});
  pipeline=createR11OfflineInboundPipeline({pool,encryptionKey:KEY,enabled:true});
 });
 after(async()=>{if(pool)await pool.end();});
}
async function accept(id,body='menu',type='MESSAGE'){
 const raw=event(id,body,type);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:raw,signature:sign(raw)})).state,'STORED');
 return digest(raw);
}
async function counts(id){
 const tables=['normalized_inbox_events','routing_decisions','safe_menu_outbox'];
 const result=[];
 for(const t of tables){
  const r=await pool.query('SELECT count(*)::int AS n FROM waba_channel.'+t+' WHERE message_id=$1',[id]);
  result.push(r.rows[0].n);
 }
 return result;
}
pgTest('Pipeline disabled by default has no storage, send or financial effect',async()=>{
 const id='wamid.pipe.disabled.A001';
 const h=await accept(id);
 const f=createR11OfflineInboundPipeline({pool,encryptionKey:KEY});
 assert.deepEqual(await f.stageEnvelope({envelopeDigest:h}),{state:'DISABLED'});
 assert.equal(f.hasExternalEffects,false);
 assert.equal(f.isFinancialDispatcher,false);
 assert.equal(f.isMetaDispatcher,false);
 assert.deepEqual(await counts(id),[0,0,0]);
});
pgTest('Pipeline signed ingress -> R6 -> R7 -> R8 yields ONE durable safe menu intent',async()=>{
 const id='wamid.pipe.menu.A002',h=await accept(id);
 assert.deepEqual(await pipeline.stageEnvelope({envelopeDigest:h}),{
  state:'STAGED_OFFLINE_NO_DISPATCH',routes:1,menuIntents:1,financialActions:0,metaSends:0
 });
 assert.deepEqual(await counts(id),[1,1,1]);
 const r=await pool.query('SELECT state FROM waba_channel.safe_menu_outbox WHERE message_id=$1',[id]);
 assert.equal(r.rows[0].state,'READY');
 const outbox=createPgSafeMenuOutbox({pool,encryptionKey:KEY,enabled:false,
  send:async()=>{throw Error('NO_PROVIDER_SEND');}});
 assert.equal((await outbox.dispatchOnce({outboxKey:keyFor({phoneNumberId:PHONE,messageId:id})})).state,'DISABLED');
 assert.deepEqual(await pipeline.stageEnvelope({envelopeDigest:h}),{
  state:'STAGED_OFFLINE_NO_DISPATCH',routes:0,menuIntents:0,financialActions:0,metaSends:0
 });
});
pgTest('Pipeline stores pay and charge commands but never stages them as menu or performs payment',async()=>{
 for(const [suffix,cmd] of [['A','pagar'],['B','cobrar'],['C','tarjetas'],['D','nip']]){
  const id='wamid.pipe.financial.'+suffix,h=await accept(id,cmd);
  const r=await pipeline.stageEnvelope({envelopeDigest:h});
  assert.equal(r.state,'STAGED_OFFLINE_NO_DISPATCH');
  assert.equal(r.routes,1);assert.equal(r.menuIntents,0);
  assert.equal(r.financialActions,0);assert.equal(r.metaSends,0);
  assert.deepEqual(await counts(id),[1,1,0]);
  const rr=await pool.query('SELECT route_code FROM waba_channel.routing_decisions WHERE message_id=$1',[id]);
  assert.equal(rr.rows[0].route_code,'AWAITING_SECURITY_ENGINE');
 }
});
pgTest('Pipeline ignores Meta status and unknown text; cannot produce a reply',async()=>{
 for(const [id,body,type] of [
  ['wamid.pipe.status.A004','','STATUS_DELIVERED'],
  ['wamid.pipe.unknown.A005','transferir todos los fondos','MESSAGE']
 ]){
  const h=await accept(id,body,type),r=await pipeline.stageEnvelope({envelopeDigest:h});
  assert.equal(r.state,'STAGED_OFFLINE_NO_DISPATCH');
  assert.equal(r.menuIntents,0);
  assert.deepEqual(await counts(id),[1,1,0]);
 }
});
pgTest('Pipeline replays R7 COMMIT -> R8 staging failure without any second command',async()=>{
 const id='wamid.pipe.recover.A006',h=await accept(id);
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.pipe_r8_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='wamid.pipe.recover.A006' THEN RAISE EXCEPTION 'offline simulated SQL abort'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER pipe_fail_stage BEFORE INSERT ON waba_channel.safe_menu_outbox FOR EACH ROW EXECUTE FUNCTION waba_channel.pipe_r8_fail()');
 try{
  const first=await pipeline.stageEnvelope({envelopeDigest:h});
  assert.equal(first.state,'RETRYABLE_NO_EFFECT');
  assert.deepEqual(await counts(id),[1,1,0]);
 }finally{
  await pool.query('DROP TRIGGER pipe_fail_stage ON waba_channel.safe_menu_outbox');
  await pool.query('DROP FUNCTION waba_channel.pipe_r8_fail()');
 }
 const result=await pipeline.stageEnvelope({envelopeDigest:h});
 assert.equal(result.state,'STAGED_OFFLINE_NO_DISPATCH');
 assert.equal(result.menuIntents,1);
 assert.deepEqual(await counts(id),[1,1,1]);
});
pgTest('Pipeline concurrent callers and fresh pool cannot duplicate a menu intent',async()=>{
 const id='wamid.pipe.race.A007',h=await accept(id);
 const workers=Array.from({length:12},()=>createR11OfflineInboundPipeline({pool,encryptionKey:KEY,enabled:true}));
 const results=await Promise.all(workers.map(x=>x.stageEnvelope({envelopeDigest:h})));
 assert.ok(results.every(x=>['STAGED_OFFLINE_NO_DISPATCH','RETRYABLE_NO_EFFECT'].includes(x.state)));
 assert.deepEqual(await counts(id),[1,1,1]);
 const fresh=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const restarted=createR11OfflineInboundPipeline({pool:fresh,encryptionKey:KEY,enabled:true});
  const replay=await restarted.stageEnvelope({envelopeDigest:h});
  assert.equal(replay.state,'STAGED_OFFLINE_NO_DISPATCH');
  assert.equal(replay.menuIntents,0);
  assert.deepEqual(await counts(id),[1,1,1]);
 }finally{await fresh.end();}
});
pgTest('Pipeline bounded routing and menu cursor advances across 150 signed events',async()=>{
 const makeChange=(offset,count)=>({field:'messages',value:{
  metadata:{phone_number_id:PHONE},
  messages:Array.from({length:count},(_,i)=>({
   id:'wamid.pipe.bulk.'+String(offset+i).padStart(4,'0'),
   from:FROM,type:'text',text:{body:'menu'}
  }))
 }});
 const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{
  changes:[makeChange(0,75),makeChange(75,75)]
 }]}));
 const h=digest(raw);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:raw,signature:sign(raw)})).state,'STORED');
 const first=await pipeline.stageEnvelope({envelopeDigest:h});
 assert.equal(first.state,'PARTIAL_OFFLINE_NO_DISPATCH');
 assert.equal(first.routes,100);
 assert.equal(first.menuIntents,100);
 const next=await pipeline.stageEnvelope({envelopeDigest:h});
 assert.equal(next.state,'STAGED_OFFLINE_NO_DISPATCH');
 assert.equal(next.routes,50);
 assert.equal(next.menuIntents,50);
 const replay=await pipeline.stageEnvelope({envelopeDigest:h});
 assert.deepEqual(replay,{
  state:'STAGED_OFFLINE_NO_DISPATCH',routes:0,menuIntents:0,financialActions:0,metaSends:0
 });
 const count=await pool.query("SELECT count(*)::int AS n FROM waba_channel.safe_menu_outbox WHERE message_id LIKE 'wamid.pipe.bulk.%'");
 assert.equal(count.rows[0].n,150);
});

pgTest('Pipeline corrupted ciphertext quarantines, never routes, never stages',async()=>{
 const id='wamid.pipe.bad.A008',h=await accept(id);
 await pool.query('UPDATE waba_channel.signed_envelopes SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE envelope_digest=$1',[h]);
 assert.equal((await pipeline.stageEnvelope({envelopeDigest:h})).state,'QUARANTINED_NO_EFFECT');
 assert.deepEqual(await counts(id),[0,0,0]);
});
pgTest('Pipeline invalid digest, unavailable DB and absent credentials are fail closed',async()=>{
 assert.equal((await pipeline.stageEnvelope({envelopeDigest:'evil'})).state,'INVALID');
 const closed=createR11OfflineInboundPipeline({
  enabled:true,pool:{query:async()=>{throw Error('PRIVATE_DB_URL');},
   connect:async()=>{throw Error('PRIVATE_DB_URL');}},encryptionKey:KEY});
 assert.equal((await closed.stageEnvelope({envelopeDigest:'a'.repeat(64)})).state,'RETRYABLE_NO_EFFECT');
 assert.throws(()=>createR11OfflineInboundPipeline({pool,encryptionKey:Buffer.alloc(16)}),/DEPENDENCIES_REQUIRED/);
});
