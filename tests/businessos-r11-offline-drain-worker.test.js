'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createPgSignedInbox}=require('../src/businessosPgSignedInbox');
const {createR11OfflineDrainWorker}=require('../src/businessosR11OfflineDrainWorker');
const KEY=crypto.createHash('sha256').update('r11-drain-key-offline-ci').digest();
const SECRET='r11-drain-meta-app-secret-test-only-123456';
const PHONE='1478834131971433',FROM='5215555550002';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const sign=b=>'sha256='+crypto.createHmac('sha256',SECRET).update(b).digest('hex');
function event(id,text='menu',kind='MESSAGE'){
 const value={metadata:{phone_number_id:PHONE}};
 if(kind==='MESSAGE')value.messages=[{id,from:FROM,type:'text',text:{body:text}}];
 else value.statuses=[{id,status:'delivered',recipient_id:FROM,timestamp:'1800000000'}];
 return Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[
  {changes:[{field:'messages',value}]}]}));
}
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const {before,after}=require('node:test');
let pool,inbox,worker;
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:20});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r5-channel.sql','waba-r6-channel.sql',
   'waba-r7-channel.sql','waba-r8-channel.sql']);
  inbox=createPgSignedInbox({pool,appSecret:SECRET,encryptionKey:KEY});
  worker=createR11OfflineDrainWorker({pool,encryptionKey:KEY,enabled:true});
 });
 after(async()=>{if(pool)await pool.end();});
}
async function accept(id,text='menu',kind='MESSAGE'){
 const bytes=event(id,text,kind);
 assert.equal((await inbox.persistSignedEnvelope({rawBody:bytes,signature:sign(bytes)})).state,'STORED');
 return digest(bytes);
}
async function counts(id){
 const tables=['normalized_inbox_events','routing_decisions','safe_menu_outbox'];
 const result=[];
 for(const table of tables){
  const r=await pool.query('SELECT count(*)::int AS n FROM waba_channel.'+table+' WHERE message_id=$1',[id]);
  result.push(r.rows[0].n);
 }
 return result;
}
test('Drain: strictly opt-in and all untrusted arguments fail closed before database',async()=>{
 let queries=0;
 const mocked={connect:async()=>{throw Error('MUST_NOT_CONNECT');},
  query:async()=>{queries++;return {rowCount:0,rows:[]};}};
 const disabled=createR11OfflineDrainWorker({pool:mocked,encryptionKey:KEY});
 assert.deepEqual(await disabled.runOnce(),{state:'DISABLED'});
 assert.equal(disabled.isAutomatic,false);
 assert.equal(disabled.hasExternalEffects,false);
 assert.equal(disabled.isFinancialDispatcher,false);
 assert.equal(disabled.isMetaDispatcher,false);
 const enabled=createR11OfflineDrainWorker({pool:mocked,encryptionKey:KEY,enabled:true});
 for(const args of [{limit:0},{limit:33},{limit:1.5},
  {envelopeDigest:'user-command'},{limit:-1}])
  assert.deepEqual(await enabled.runOnce(args),{state:'INVALID'});
 assert.equal(queries,0);
 assert.throws(()=>createR11OfflineDrainWorker({
  pool:mocked,encryptionKey:Buffer.alloc(12)}),/DEPENDENCIES_REQUIRED/);
});
test('Drain: selector includes every recovery boundary and excludes quarantine',async()=>{
 let observed;
 const stub={connect:async()=>{throw Error('NEVER_USED');},
  query:async(sql,params)=>{observed={sql,params};return {rowCount:0,rows:[]};}};
 const w=createR11OfflineDrainWorker({pool:stub,encryptionKey:KEY,enabled:true});
 assert.deepEqual(await w.runOnce({limit:7}),{
  state:'IDLE_NO_EFFECT',envelopes:0,routes:0,menuIntents:0,
  financialActions:0,metaSends:0
 });
 assert.deepEqual(observed.params,[null,7]);
 for(const needle of ['quarantined_at IS NULL','normalized_at IS NULL',
  'normalized_inbox_events','routing_decisions','safe_menu_outbox'])
  assert.ok(observed.sql.includes(needle));
});
pgTest('Drain: signed menu stages exactly one durable R8 intent, then IDLE',async()=>{
 const id='wamid.r11.drain.menu.A001',h=await accept(id);
 const first=await worker.runOnce({envelopeDigest:h,limit:2});
 assert.equal(first.state,'DRAINED_OFFLINE_NO_DISPATCH');
 assert.equal(first.envelopes,1);assert.equal(first.routes,1);
 assert.equal(first.menuIntents,1);assert.equal(first.metaSends,0);
 assert.equal(first.financialActions,0);
 assert.deepEqual(await counts(id),[1,1,1]);
 assert.deepEqual(await worker.runOnce({envelopeDigest:h}),{
  state:'IDLE_NO_EFFECT',envelopes:0,routes:0,menuIntents:0,
  financialActions:0,metaSends:0});
});
pgTest('Drain: money commands and Meta status remain staged but never sent',async()=>{
 for(const [suffix,text,kind] of [
  ['A','pagar','MESSAGE'],['B','cobrar','MESSAGE'],
  ['C','nip','MESSAGE'],['D','','STATUS_DELIVERED']]){
  const id='wamid.r11.drain.blocked.'+suffix,h=await accept(id,text,kind);
  const out=await worker.runOnce({envelopeDigest:h,limit:2});
  assert.equal(out.state,'DRAINED_OFFLINE_NO_DISPATCH');
  assert.equal(out.menuIntents,0);assert.equal(out.financialActions,0);
  assert.equal(out.metaSends,0);
  assert.deepEqual(await counts(id),[1,1,0]);
 }
});
pgTest('Drain: R7 committed but R8 failed is recoverable without new envelope',async()=>{
 const id='wamid.r11.drain.recover.A003',h=await accept(id);
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r11_drain_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='wamid.r11.drain.recover.A003' THEN RAISE EXCEPTION 'expected offline rollback'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r11_drain_abort_tr BEFORE INSERT ON waba_channel.safe_menu_outbox FOR EACH ROW EXECUTE FUNCTION waba_channel.r11_drain_abort()');
 try{
  const r=await worker.runOnce({envelopeDigest:h});
  assert.equal(r.state,'RETRYABLE_NO_EFFECT');
  assert.deepEqual(await counts(id),[1,1,0]);
 }finally{
  await pool.query('DROP TRIGGER r11_drain_abort_tr ON waba_channel.safe_menu_outbox');
  await pool.query('DROP FUNCTION waba_channel.r11_drain_abort()');
 }
 const recovered=await worker.runOnce({envelopeDigest:h,limit:2});
 assert.equal(recovered.state,'DRAINED_OFFLINE_NO_DISPATCH');
 assert.equal(recovered.menuIntents,1);
 assert.deepEqual(await counts(id),[1,1,1]);
});
pgTest('Drain: twelve simultaneous callers, one durable menu; clean after restart',async()=>{
 const id='wamid.r11.drain.parallel.A004',h=await accept(id);
 const workers=Array.from({length:12},()=>createR11OfflineDrainWorker({
  pool,encryptionKey:KEY,enabled:true}));
 const results=await Promise.all(workers.map(w=>w.runOnce({envelopeDigest:h,limit:2})));
 assert.ok(results.every(r=>[
  'DRAINED_OFFLINE_NO_DISPATCH','RETRYABLE_NO_EFFECT'
 ].includes(r.state)));
 assert.deepEqual(await counts(id),[1,1,1]);
 const fresh=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const afterRestart=createR11OfflineDrainWorker({
   pool:fresh,encryptionKey:KEY,enabled:true});
  assert.equal((await afterRestart.runOnce({envelopeDigest:h})).state,'IDLE_NO_EFFECT');
  assert.deepEqual(await counts(id),[1,1,1]);
 }finally{await fresh.end();}
});
pgTest('Drain: 150 signed menu events continue in bounded 100-item batches',async()=>{
 const id='wamid.r11.drain.bulk.',changes=[0,75].map(start=>({
  field:'messages',value:{metadata:{phone_number_id:PHONE},
   messages:Array.from({length:75},(_,i)=>({
    id:id+String(start+i).padStart(4,'0'),from:FROM,type:'text',text:{body:'menu'}
   }))
  }
 }));
 const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{changes}]}));
 assert.equal((await inbox.persistSignedEnvelope({rawBody:raw,signature:sign(raw)})).state,'STORED');
 const h=digest(raw);
 const first=await worker.runOnce({envelopeDigest:h,limit:2});
 assert.equal(first.state,'MORE_WORK_OFFLINE_NO_DISPATCH');
 assert.equal(first.routes,100);assert.equal(first.menuIntents,100);
 const second=await worker.runOnce({envelopeDigest:h,limit:2});
 assert.equal(second.state,'DRAINED_OFFLINE_NO_DISPATCH');
 assert.equal(second.routes,50);assert.equal(second.menuIntents,50);
 assert.equal((await worker.runOnce({envelopeDigest:h})).state,'IDLE_NO_EFFECT');
 const r=await pool.query("SELECT count(*)::int AS n FROM waba_channel.safe_menu_outbox WHERE message_id LIKE 'wamid.r11.drain.bulk.%'");
 assert.equal(r.rows[0].n,150);
});
pgTest('Drain: AES-GCM tampering quarantines; no R7/R8 effect',async()=>{
 const id='wamid.r11.drain.bad.A005',h=await accept(id);
 await pool.query('UPDATE waba_channel.signed_envelopes SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE envelope_digest=$1',[h]);
 const out=await worker.runOnce({envelopeDigest:h,limit:2});
 assert.equal(out.state,'DRAINED_OFFLINE_NO_DISPATCH');
 assert.equal(out.menuIntents,0);
 assert.deepEqual(await counts(id),[0,0,0]);
 assert.equal((await worker.runOnce({envelopeDigest:h})).state,'IDLE_NO_EFFECT');
});
test('Drain: database outage does not leak SQL/secret and never sends',async()=>{
 const failed=createR11OfflineDrainWorker({pool:{
  connect:async()=>{throw Error('PRIVATE_DB_TOKEN');},
  query:async()=>{throw Error('PRIVATE_DB_TOKEN');}
 },encryptionKey:KEY,enabled:true});
 assert.deepEqual(await failed.runOnce(),{state:'RETRYABLE_NO_EFFECT'});
});
