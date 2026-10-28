'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {createPgSignedInbox}=require('../src/businessosPgSignedInbox');
const {createPgInboxNormalizer}=require('../src/businessosPgInboxNormalizer');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const SECRET='r6-offline-meta-app-secret-only-for-ci',KEY=crypto.createHash('sha256').update('offline-r6-crypto-key').digest();
const sign=raw=>'sha256='+crypto.createHmac('sha256',SECRET).update(raw).digest('hex');
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const phone='1478834131971433';
function raw(id,body='cobrar',pretty=false){
 return Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{
  field:'messages',value:{metadata:{phone_number_id:phone},
  messages:[{id,from:'5215555550002',type:'text',text:{body}}]}
 }]}]},null,pretty?2:0));
}
let pool,ingress,worker;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:15});
  for(const f of ['waba-r4-channel.sql','waba-r5-channel.sql','waba-r6-channel.sql'])
   await pool.query(fs.readFileSync(path.resolve(__dirname,'../db',f),'utf8'));
  ingress=createPgSignedInbox({pool,appSecret:SECRET,encryptionKey:KEY});
  worker=createPgInboxNormalizer({pool,encryptionKey:KEY});
 });
 after(async()=>{if(pool)await pool.end();});
}
async function accept(body){
 assert.equal((await ingress.persistSignedEnvelope({rawBody:body,signature:sign(body)})).state,'STORED');
 return sha(body);
}
async function fact(id){
 const r=await pool.query('SELECT count(*)::int AS n FROM waba_channel.normalized_inbox_events WHERE message_id=$1',[id]);
 return r.rows[0].n;
}
async function checkpoint(h){
 const r=await pool.query('SELECT normalized_at,quarantined_at,quarantine_code FROM waba_channel.signed_envelopes WHERE envelope_digest=$1',[h]);
 return r.rows[0];
}
pgTest('R6 committed normalized event is durable and exactly once',async()=>{
 const id='wamid.r6.basic.AAAA',h=await accept(raw(id));
 assert.deepEqual(await worker.processNext({envelopeDigest:h}),{state:'NORMALIZED',facts:1,duplicates:0});
 assert.equal((await worker.processNext({envelopeDigest:h})).state,'EMPTY');
 assert.equal(await fact(id),1);assert.ok((await checkpoint(h)).normalized_at);
});
pgTest('R6 differently serialized envelopes with the same Meta ID yield one fact',async()=>{
 const id='wamid.r6.replay.AAAA',a=raw(id,'menu'),b=raw(id,'menu',true),h=await accept(a);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:b,signature:sign(b)})).state,'DUPLICATE');
 assert.equal((await worker.processNext({envelopeDigest:h})).facts,1);
 assert.deepEqual(await worker.processNext({envelopeDigest:sha(b)}),{state:'NORMALIZED',facts:0,duplicates:1});
 assert.equal(await fact(id),1);
});
pgTest('R6 many concurrent workers use SKIP LOCKED to process only once',async()=>{
 const id='wamid.r6.workers.AAAA',h=await accept(raw(id));
 const all=await Promise.all(Array.from({length:10},()=>createPgInboxNormalizer({pool,encryptionKey:KEY}).processNext({envelopeDigest:h})));
 assert.equal(all.filter(x=>x.state==='NORMALIZED').length,1);
 assert.equal(all.filter(x=>x.state==='EMPTY').length,9);
 assert.equal(await fact(id),1);
});
pgTest('R6 skipped locked envelope resumes after transaction rollback',async()=>{
 const id='wamid.r6.crash.AAAA',h=await accept(raw(id)),c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query('SELECT envelope_digest FROM waba_channel.signed_envelopes WHERE envelope_digest=$1 FOR UPDATE',[h]);
  assert.equal((await worker.processNext({envelopeDigest:h})).state,'EMPTY');
  await c.query('ROLLBACK');
  assert.equal((await worker.processNext({envelopeDigest:h})).state,'NORMALIZED');
  assert.equal(await fact(id),1);
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
});
pgTest('R6 SQL failure rolls back facts and checkpoint then succeeds on retry',async()=>{
 const id='wamid.r6.abort.AAAA',h=await accept(raw(id));
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r6_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='wamid.r6.abort.AAAA' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r6_test_abort BEFORE INSERT ON waba_channel.normalized_inbox_events FOR EACH ROW EXECUTE FUNCTION waba_channel.r6_test_fail()');
 try{
  assert.equal((await worker.processNext({envelopeDigest:h})).state,'RETRYABLE_NO_EFFECT');
  assert.equal(await fact(id),0);assert.equal((await checkpoint(h)).normalized_at,null);
 }finally{
  await pool.query('DROP TRIGGER r6_test_abort ON waba_channel.normalized_inbox_events');
  await pool.query('DROP FUNCTION waba_channel.r6_test_fail()');
 }
 assert.equal((await worker.processNext({envelopeDigest:h})).state,'NORMALIZED');
 assert.equal(await fact(id),1);
});
pgTest('R6 tampered ciphertext quarantines permanently, does not mark processed',async()=>{
 const id='wamid.r6.tamper.AAAA',h=await accept(raw(id));
 await pool.query('UPDATE waba_channel.signed_envelopes SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE envelope_digest=$1',[h]);
 assert.deepEqual(await worker.processNext({envelopeDigest:h}),{state:'QUARANTINED',code:'AUTHENTICATION_FAILED'});
 assert.equal(await fact(id),0);assert.equal((await checkpoint(h)).normalized_at,null);
 assert.ok((await checkpoint(h)).quarantined_at);
 assert.equal((await worker.processNext({envelopeDigest:h})).state,'EMPTY');
});
pgTest('R6 reencrypted altered content is caught by SHA-256 digest',async()=>{
 const id='wamid.r6.digest.AAAA',h=await accept(raw(id)),nonce=crypto.randomBytes(12);
 const cipher=crypto.createCipheriv('aes-256-gcm',KEY,nonce);
 const ciphertext=Buffer.concat([cipher.update(raw('wamid.r6.digest.FORGED')),cipher.final()]);
 await pool.query('UPDATE waba_channel.signed_envelopes SET nonce=$2,tag=$3,ciphertext=$4 WHERE envelope_digest=$1',
  [h,nonce,cipher.getAuthTag(),ciphertext]);
 assert.deepEqual(await worker.processNext({envelopeDigest:h}),{state:'QUARANTINED',code:'DIGEST_MISMATCH'});
 assert.equal(await fact('wamid.r6.digest.FORGED'),0);
});
pgTest('R6 missing R5 authenticated inbox identity causes quarantine, never insertion',async()=>{
 const id='wamid.r6.missing.AAAA',h=await accept(raw(id));
 await pool.query('DELETE FROM waba_channel.inbox WHERE message_id=$1',[id]);
 assert.deepEqual(await worker.processNext({envelopeDigest:h}),{state:'QUARANTINED',code:'INBOX_IDENTITY_MISMATCH'});
 assert.equal(await fact(id),0);
});
pgTest('R6 restart with fresh pool does not replay normalized facts or send anything',async()=>{
 const id='wamid.r6.restart.AAAA',h=await accept(raw(id));
 assert.equal((await worker.processNext({envelopeDigest:h})).state,'NORMALIZED');
 const other=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const fresh=createPgInboxNormalizer({pool:other,encryptionKey:KEY});
  assert.equal((await fresh.processNext({envelopeDigest:h})).state,'EMPTY');
  assert.equal(fresh.hasExternalEffects,false);
  assert.equal(await fact(id),1);
 }finally{await other.end();}
});
pgTest('R6 wrong digest selector and invalid decryption key fail closed',async()=>{
 assert.equal((await worker.processNext({envelopeDigest:'forged'})).state,'INVALID');
 assert.throws(()=>createPgInboxNormalizer({pool,encryptionKey:Buffer.alloc(10)}),/R6_CONFIG_INVALID/);
});

pgTest('R6 database connect outage returns retryable without exposing driver errors',async()=>{
 const disconnected=createPgInboxNormalizer({
  pool:{connect:async()=>{throw Error('PASSWORD_AND_HOST_MUST_NOT_LEAK');}},
  encryptionKey:KEY
 });
 assert.deepEqual(await disconnected.processNext(),{state:'RETRYABLE_NO_EFFECT'});
});
