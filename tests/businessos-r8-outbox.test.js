'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createPgSignedInbox}=require('../src/businessosPgSignedInbox');
const {createPgInboxNormalizer}=require('../src/businessosPgInboxNormalizer');
const {createPgRoutingGate}=require('../src/businessosPgRoutingGate');
const {createPgSafeMenuOutbox,keyFor,MENU_TEXT}=
 require('../src/businessosPgSafeMenuOutbox');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const KEY=crypto.createHash('sha256').update('r8-offline-aes-key').digest();
const SECRET='r8-meta-test-secret-for-ci-only-123456';
const PHONE='1478834131971433',FROM='5215555550002';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const sign=b=>'sha256='+crypto.createHmac('sha256',SECRET).update(b).digest('hex');
function event(id,body='menu',kind='MESSAGE'){
 const value={metadata:{phone_number_id:PHONE}};
 if(kind==='MESSAGE')value.messages=[{id,from:FROM,type:'text',text:{body}}];
 else value.statuses=[{id,status:'delivered',recipient_id:FROM,timestamp:'1800000000'}];
 return Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{
  field:'messages',value
 }]}]}));
}
const {before,after}=require('node:test');
let pool,ingress,normalizer,router,called;
function makeOutbox({enabled=true,send=async()=>({accepted:true,messageId:'wamid.response.r8.ACCEPTED'})}={}){
 return createPgSafeMenuOutbox({pool,encryptionKey:KEY,enabled,send});
}
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:18});
  await applyTestChannelMigrations(pool,[
   'waba-r4-channel.sql','waba-r5-channel.sql','waba-r6-channel.sql',
   'waba-r7-channel.sql','waba-r8-channel.sql']);
  ingress=createPgSignedInbox({pool,appSecret:SECRET,encryptionKey:KEY});
  normalizer=createPgInboxNormalizer({pool,encryptionKey:KEY});
  router=createPgRoutingGate({pool,encryptionKey:KEY});
 });
 after(async()=>{if(pool)await pool.end();});
}
async function ready(id,text='menu',kind='MESSAGE'){
 const body=event(id,text,kind),d=digest(body);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:body,signature:sign(body)})).state,'STORED');
 assert.equal((await normalizer.processNext({envelopeDigest:d})).state,'NORMALIZED');
 const staged=await router.stageNext({messageId:id});
 assert.equal(staged.state,'STAGED_NO_EFFECT');
 return staged.routeCode;
}
async function row(key){
 const r=await pool.query('SELECT state,provider_message_id,reserved_at,accepted_at FROM waba_channel.safe_menu_outbox WHERE outbox_key=$1',[key]);
 return r.rows[0]||null;
}
pgTest('R8 only safe menu gets durable staged outbox; no user PII or bearer columns',async()=>{
 const id='wamid.r8.menu.AAAA';
 assert.equal(await ready(id,'menu'),'MENU_CANDIDATE');
 const o=makeOutbox({enabled:false,send:async()=>{throw Error('NO_SEND');}});
 const key=keyFor({phoneNumberId:PHONE,messageId:id});
 assert.deepEqual(await o.stage({phoneNumberId:PHONE,messageId:id}),{state:'STAGED',outboxKey:key});
 assert.deepEqual(await o.stage({phoneNumberId:PHONE,messageId:id}),{state:'ALREADY_STAGED',outboxKey:key});
 assert.deepEqual(await o.dispatchOnce({outboxKey:key}),{state:'DISABLED'});
 assert.equal((await row(key)).state,'READY');
 const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='waba_channel' AND table_name='safe_menu_outbox'")).rows.map(r=>r.column_name);
 for(const forbidden of ['recipient_wa_id','bearer','card_number','message_text','payment_status','amount_cents'])
  assert.equal(columns.includes(forbidden),false);
});
pgTest('R8 pagar/cobrar and statuses cannot be staged as menu, zero send',async()=>{
 const o=makeOutbox();
 for(const [suffix,text,kind] of [
  ['PAY','pagar','MESSAGE'],['COLLECT','cobrar','MESSAGE'],
  ['STATUS','', 'STATUS_DELIVERED'],['UNKNOWN','transferir dinero','MESSAGE']
 ]){
  const id='wamid.r8.blocked.'+suffix;
  assert.notEqual(await ready(id,text,kind),'MENU_CANDIDATE');
  assert.equal((await o.stage({phoneNumberId:PHONE,messageId:id})).state,'NOT_ELIGIBLE');
 }
 const r=await pool.query("SELECT count(*)::int AS n FROM waba_channel.safe_menu_outbox WHERE message_id LIKE 'wamid.r8.blocked.%'");
 assert.equal(r.rows[0].n,0);
});
pgTest('R8 verified menu single-shot fake provider acceptance is not delivered or PAID',async()=>{
 const id='wamid.r8.accept.AAAA';await ready(id,'menú');
 let sent=0,deliveredInput;
 const o=makeOutbox({send:async input=>{
  sent++;deliveredInput=input;
  return {accepted:true,messageId:'wamid.r8.provider.ACCEPT'};
 }});
 const staged=await o.stage({phoneNumberId:PHONE,messageId:id});
 assert.equal(staged.state,'STAGED');
 const result=await o.dispatchOnce({outboxKey:staged.outboxKey});
 assert.deepEqual(result,{state:'PROVIDER_ACCEPTED_NOT_DELIVERED'});
 assert.equal(sent,1);
 assert.deepEqual(deliveredInput,{
  to:FROM,text:MENU_TEXT,correlationId:staged.outboxKey,kind:'SAFE_MENU_ONLY'
 });
 assert.doesNotMatch(deliveredInput.text,/pago completado|recibo|cobrado|autorizado/i);
 const saved=await row(staged.outboxKey);
 assert.equal(saved.state,'PROVIDER_ACCEPTED');
 assert.equal(saved.provider_message_id,'wamid.r8.provider.ACCEPT');
 assert.ok(saved.reserved_at);assert.ok(saved.accepted_at);
 assert.equal((await o.dispatchOnce({outboxKey:staged.outboxKey})).state,'HOLD_OR_NOT_READY');
 assert.equal(sent,1);
});
pgTest('R8 twelve concurrent workers lead to one fake send and no duplicate',async()=>{
 const id='wamid.r8.concurrent.AAAA';await ready(id);
 let count=0;
 const send=async()=>{count++;return {accepted:true,messageId:'wamid.r8.provider.CONCURRENT'};};
 const key=(await makeOutbox({send}).stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 const attempts=await Promise.all(Array.from({length:12},()=>
  makeOutbox({send}).dispatchOnce({outboxKey:key})));
 assert.equal(count,1);
 assert.equal(attempts.filter(r=>r.state==='PROVIDER_ACCEPTED_NOT_DELIVERED').length,1);
 assert.equal(attempts.filter(r=>r.state==='HOLD_OR_NOT_READY').length,11);
 assert.equal((await row(key)).state,'PROVIDER_ACCEPTED');
});
pgTest('R8 unknown transport error holds permanently and does not auto-retry after reconnect',async()=>{
 const id='wamid.r8.unknown.AAAA';await ready(id);
 let count=0;
 const o=makeOutbox({send:async()=>{count++;throw Error('TOKEN_SECRET_OR_PROVIDER_ERROR');}});
 const key=(await o.stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 assert.deepEqual(await o.dispatchOnce({outboxKey:key}),{state:'UNKNOWN_HOLD_NO_RETRY'});
 assert.equal((await row(key)).state,'UNKNOWN_HOLD');
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'HOLD_OR_NOT_READY');
 const second=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const recovered=createPgSafeMenuOutbox({pool:second,encryptionKey:KEY,enabled:true,
   send:async()=>{count++;throw Error('MUST_NOT_SEND');}});
  assert.equal((await recovered.dispatchOnce({outboxKey:key})).state,'HOLD_OR_NOT_READY');
 }finally{await second.end();}
 assert.equal(count,1);
});
pgTest('R8 simulated crash after durable reserve and BEFORE send stays HOLD after restart',async()=>{
 const id='wamid.r8.crash.AAAA';await ready(id);
 let count=0;
 const o=makeOutbox({send:async()=>{count++;}});
 const key=(await o.stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 const reserved=await o.reserve({outboxKey:key});
 assert.equal(reserved.state,'RESERVED');
 assert.equal(reserved.recipient,FROM);
 assert.equal((await row(key)).state,'UNKNOWN_HOLD');
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'HOLD_OR_NOT_READY');
 assert.equal(count,0);
});
pgTest('R8 malformed provider acknowledgement stays HOLD and cannot claim delivery',async()=>{
 const id='wamid.r8.malformed.AAAA';await ready(id);
 let count=0;
 const o=makeOutbox({send:async()=>{
  count++;return {accepted:true,messageId:'fake-but-not-a-Meta-id'};
 }});
 const key=(await o.stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'UNKNOWN_HOLD_NO_RETRY');
 assert.equal((await row(key)).state,'UNKNOWN_HOLD');
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'HOLD_OR_NOT_READY');
 assert.equal(count,1);
});
pgTest('R8 corrupted encrypted original prevents reserve and never emits transport',async()=>{
 const id='wamid.r8.tampered.AAAA',body=event(id);
 await ready(id);
 let count=0;
 const o=makeOutbox({send:async()=>{count++;return {accepted:true,messageId:'wamid.fake.AAAA'};}});
 const key=(await o.stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 await pool.query('UPDATE waba_channel.signed_envelopes SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE envelope_digest=$1',[digest(body)]);
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'UNVERIFIED_NO_EFFECT');
 assert.equal((await row(key)).state,'READY');
 assert.equal(count,0);
});
pgTest('R8 database abort before reservation COMMIT prevents sending; can retry safely',async()=>{
 const id='wamid.r8.dbfail.AAAA';await ready(id);
 let count=0;
 const o=makeOutbox({send:async()=>{count++;return {accepted:true,messageId:'wamid.r8.provider.DBFIX'};}});
 const key=(await o.stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r8_fail_reserve() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='wamid.r8.dbfail.AAAA' AND NEW.state='UNKNOWN_HOLD' THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r8_test_reserve BEFORE UPDATE ON waba_channel.safe_menu_outbox FOR EACH ROW EXECUTE FUNCTION waba_channel.r8_fail_reserve()');
 try{
  assert.equal((await o.dispatchOnce({outboxKey:key})).state,'DB_UNAVAILABLE_NO_EFFECT');
  assert.equal((await row(key)).state,'READY');
  assert.equal(count,0);
 }finally{
  await pool.query('DROP TRIGGER r8_test_reserve ON waba_channel.safe_menu_outbox');
  await pool.query('DROP FUNCTION waba_channel.r8_fail_reserve()');
 }
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'PROVIDER_ACCEPTED_NOT_DELIVERED');
 assert.equal(count,1);
});
pgTest('R8 database failure after fake provider response remains HOLD with no retry',async()=>{
 const id='wamid.r8.ackfail.AAAA';await ready(id);
 let count=0;
 const o=makeOutbox({send:async()=>{count++;return {accepted:true,messageId:'wamid.r8.provider.ACKFAIL'};}});
 const key=(await o.stage({phoneNumberId:PHONE,messageId:id})).outboxKey;
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r8_fail_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='wamid.r8.ackfail.AAAA' AND NEW.state='PROVIDER_ACCEPTED' THEN RAISE EXCEPTION 'forced ack rollback'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r8_test_ack BEFORE UPDATE ON waba_channel.safe_menu_outbox FOR EACH ROW EXECUTE FUNCTION waba_channel.r8_fail_ack()');
 try{
  assert.equal((await o.dispatchOnce({outboxKey:key})).state,'UNKNOWN_HOLD_NO_RETRY');
  assert.equal((await row(key)).state,'UNKNOWN_HOLD');
 }finally{
  await pool.query('DROP TRIGGER r8_test_ack ON waba_channel.safe_menu_outbox');
  await pool.query('DROP FUNCTION waba_channel.r8_fail_ack()');
 }
 assert.equal((await o.dispatchOnce({outboxKey:key})).state,'HOLD_OR_NOT_READY');
 assert.equal(count,1);
});
pgTest('R8 invalid keys and disconnected postgres are fail closed without leaking credentials',async()=>{
 let count=0;
 const o=makeOutbox({send:async()=>{count++;}});
 assert.equal((await o.dispatchOnce({outboxKey:'fake'})).state,'INVALID');
 assert.equal((await o.stage({phoneNumberId:'invalid',messageId:'forged'})).state,'INVALID');
 const disconnected=createPgSafeMenuOutbox({
  pool:{connect:async()=>{throw Error('PRIVATE_PASSWORD');}},
  encryptionKey:KEY,enabled:true,send:async()=>{count++;}
 });
 assert.equal((await disconnected.dispatchOnce({outboxKey:'a'.repeat(64)})).state,'DB_UNAVAILABLE_NO_EFFECT');
 assert.equal(count,0);
});
