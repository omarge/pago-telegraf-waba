'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {createPostgresChannelStore}=require('../src/businessosPgChannelStore');
const {createPgPayerClaims}=require('../src/businessosPgPayerClaims');
const {createPgSignedInbox}=require('../src/businessosPgSignedInbox');
const {createWebhookApp}=require('../src/index');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const order=n=>'KPR-'+n.repeat(32),requester='5215555550002',payer='payer-r5';
const secret='meta-r5-app-secret-offline-only-123456';
const key=crypto.createHash('sha256').update('r5-test-key-offline').digest();
const sign=raw=>'sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');
const body=(id,text)=>Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{
 changes:[{field:'messages',value:{metadata:{phone_number_id:'1478834131971433'},
 messages:[{id,from:requester,type:'text',text:{body:text}}]}}]}]}));
const {before,after}=require('node:test');
let pool,store,claims,inbox;
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:12});
  await pool.query(fs.readFileSync(path.resolve(__dirname,'../db/waba-r4-channel.sql'),'utf8'));
  await pool.query(fs.readFileSync(path.resolve(__dirname,'../db/waba-r5-channel.sql'),'utf8'));
  store=createPostgresChannelStore({pool});
  claims=createPgPayerClaims({pool});
  inbox=createPgSignedInbox({pool,appSecret:secret,encryptionKey:key});
 });
 after(async()=>{if(pool)await pool.end();});
}
pgTest('R5 request and claim bind atomically, do not persist plain secret',async()=>{
 const id=order('1');await store.createRequest({requestId:id,requesterId:requester,amountCents:1250});
 const g=await claims.issue({requestId:id});
 assert.equal(g.state,'ISSUED');assert.ok(g.claimSecret.length>=30);
 const r=await pool.query('SELECT challenge_hash FROM waba_channel.payer_claims WHERE request_id=$1',[id]);
 assert.ok(!JSON.stringify(r.rows).includes(g.claimSecret));
 assert.equal((await claims.claim({requestId:id,claimSecret:g.claimSecret,accountId:payer,
  csrfVerified:true,whatsappLinked:true})).state,'CLAIMED');
 assert.equal((await store.getRequest(id)).payerAccountId,payer);
 assert.equal((await claims.claim({requestId:id,claimSecret:g.claimSecret,accountId:'outsider',
  csrfVerified:true,whatsappLinked:true})).state,'ALREADY_CLAIMED');
});
pgTest('R5 competing issuers and claimants serialize on same PostgreSQL row',async()=>{
 const id=order('2');await store.createRequest({requestId:id,requesterId:requester,amountCents:2200});
 const second=createPgPayerClaims({pool});
 const issued=await Promise.all([claims.issue({requestId:id}),second.issue({requestId:id})]);
 assert.deepEqual(issued.map(x=>x.state).sort(),['ALREADY_ISSUED','ISSUED']);
 const code=issued.find(x=>x.state==='ISSUED').claimSecret;
 const results=await Promise.all(['payer-a','payer-b'].map((accountId,i)=>
  (i?second:claims).claim({requestId:id,claimSecret:code,accountId,
   csrfVerified:true,whatsappLinked:true})));
 assert.deepEqual(results.map(x=>x.state).sort(),['ALREADY_CLAIMED','CLAIMED']);
 assert.ok(['payer-a','payer-b'].includes((await store.getRequest(id)).payerAccountId));
});
pgTest('R5 wrong code, missing consent context, expiry never set owner',async()=>{
 const id=order('3');await store.createRequest({requestId:id,requesterId:requester,amountCents:1234});
 const g=await claims.issue({requestId:id});
 for(const args of [
  {csrfVerified:false,whatsappLinked:true,claimSecret:g.claimSecret},
  {csrfVerified:true,whatsappLinked:false,claimSecret:g.claimSecret},
  {csrfVerified:true,whatsappLinked:true,claimSecret:'not-the-correct-claim-token-123456789'}
 ]){
  assert.equal((await claims.claim({requestId:id,accountId:payer,...args})).state,'DENIED');
 }
 await pool.query("UPDATE waba_channel.payer_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",[id]);
 assert.equal((await claims.claim({requestId:id,accountId:payer,claimSecret:g.claimSecret,
  csrfVerified:true,whatsappLinked:true})).state,'EXPIRED');
 assert.equal((await store.getRequest(id)).payerAccountId,null);
 const again=await claims.issue({requestId:id});
 assert.equal(again.state,'ISSUED');assert.notEqual(again.claimSecret,g.claimSecret);
});
pgTest('R5 restart/reconnect recovers payer and rejects reissue',async()=>{
 const id=order('4');await store.createRequest({requestId:id,requesterId:requester,amountCents:1234});
 const g=await claims.issue({requestId:id});
 await claims.claim({requestId:id,accountId:payer,claimSecret:g.claimSecret,csrfVerified:true,whatsappLinked:true});
 const p2=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  assert.equal((await createPostgresChannelStore({pool:p2}).getRequest(id)).payerAccountId,payer);
  assert.equal((await createPgPayerClaims({pool:p2}).issue({requestId:id})).state,'ALREADY_CLAIMED');
 }finally{await p2.end();}
});
pgTest('R5 blocked request cannot issue claim',async()=>{
 const id=order('5');await store.createRequest({requestId:id,requesterId:requester,amountCents:1250});
 await pool.query('UPDATE waba_channel.requests SET state=$2 WHERE request_id=$1',[id,'BLOCKED']);
 assert.equal((await claims.issue({requestId:id})).state,'NOT_PENDING');
});
pgTest('R5 signed encrypted inbox saves once, survives replay, contains no plaintext',async()=>{
 const raw=body('wamid.r5.AAAA','menu');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:raw,signature:sign(raw)})).state,'STORED');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:raw,signature:sign(raw)})).state,'DUPLICATE');
 const hash=crypto.createHash('sha256').update(raw).digest('hex');
 const r=await pool.query('SELECT nonce,tag,ciphertext FROM waba_channel.signed_envelopes WHERE envelope_digest=$1',[hash]);
 assert.equal(r.rowCount,1);assert.ok(!r.rows[0].ciphertext.includes(Buffer.from('menu')));
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,r.rows[0].nonce);
 decipher.setAuthTag(r.rows[0].tag);
 assert.deepEqual(Buffer.concat([decipher.update(r.rows[0].ciphertext),decipher.final()]),raw);
 const m=await pool.query('SELECT count(*)::int AS n FROM waba_channel.inbox WHERE message_id=$1',['wamid.r5.AAAA']);
 assert.equal(m.rows[0].n,1);
});
pgTest('R5 invalid signature, altered bytes, malformed envelope cannot write',async()=>{
 const raw=body('wamid.r5.BBBB','cobrar');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:raw,signature:'sha256='+('0'.repeat(64))})).state,'UNVERIFIED');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:raw,signature:sign(body('wamid.r5.BBBB','pagar'))})).state,'UNVERIFIED');
 const malformed=Buffer.from('{');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:malformed,signature:sign(malformed)})).state,'INVALID');
 const bad=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[]}));
 assert.equal((await inbox.persistSignedEnvelope({rawBody:bad,signature:sign(bad)})).state,'INVALID');
 const count=await pool.query('SELECT count(*)::int AS n FROM waba_channel.inbox WHERE message_id=$1',['wamid.r5.BBBB']);
 assert.equal(count.rows[0].n,0);
});
pgTest('R5 conflicting signed message content with same wamid causes rollback',async()=>{
 const a=body('wamid.r5.CCCC','cobrar'),b=body('wamid.r5.CCCC','pagar');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:a,signature:sign(a)})).state,'STORED');
 assert.equal((await inbox.persistSignedEnvelope({rawBody:b,signature:sign(b)})).state,'CONFLICT');
 const found=await pool.query('SELECT count(*)::int AS n FROM waba_channel.signed_envelopes WHERE envelope_digest=$1',
  [crypto.createHash('sha256').update(b).digest('hex')]);
 assert.equal(found.rows[0].n,0);
});
async function server(app){
 const s=await new Promise(ok=>{const listener=app.listen(0,'127.0.0.1',()=>ok(listener));});
 return {base:'http://127.0.0.1:'+s.address().port,
  close:()=>new Promise(ok=>s.close(ok))};
}
const post=(s,raw,sig)=>fetch(s.base+'/webhook',{method:'POST',
 headers:{'Content-Type':'application/json','X-Hub-Signature-256':sig},body:raw});
pgTest('R5 optional webhook HTTP ack only after storage; no handler side effects',async()=>{
 let handled=0;
 const s=await server(createWebhookApp({appSecret:secret,durableInbox:inbox,onWebhook:async()=>{handled++;}}));
 try{
  const raw=body('wamid.r5.DDDD','menu');
  assert.equal((await post(s,raw,sign(raw))).status,200);
  assert.equal((await post(s,raw,sign(raw))).status,200);
  assert.equal(handled,0);
  const count=await pool.query('SELECT count(*)::int AS n FROM waba_channel.inbox WHERE message_id=$1',['wamid.r5.DDDD']);
  assert.equal(count.rows[0].n,1);
  assert.equal((await post(s,raw,'sha256='+('0'.repeat(64)))).status,403);
 }finally{await s.close();}
});
pgTest('R5 database unavailable prevents 200 and prevents handler',async()=>{
 let handled=0,called=0;
 const failing={isDurableSignedInbox:true,persistSignedEnvelope:async()=>{called++;throw Error('fake DB offline');}};
 const s=await server(createWebhookApp({appSecret:secret,durableInbox:failing,onWebhook:async()=>{handled++;}}));
 try{
  const raw=body('wamid.r5.EEEE','menu');
  assert.equal((await post(s,raw,sign(raw))).status,503);
  assert.equal(called,1);assert.equal(handled,0);
 }finally{await s.close();}
});
