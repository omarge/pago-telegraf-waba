'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createDurableIngress,durableMode}=require('../src/businessosDurableIngressBootstrap');
const {createWebhookApp}=require('../src/index');
const SECRET='h3-offline-meta-secret-not-a-real-secret-12345';
const KEY=crypto.createHash('sha256').update('h3-offline-aes-key-fixture').digest('hex');
const sign=raw=>'sha256='+crypto.createHmac('sha256',SECRET).update(raw).digest('hex');
const raw=id=>Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{
 changes:[{field:'messages',value:{metadata:{phone_number_id:'1478834131971433'},
  messages:[{id,from:'5215555550002',type:'text',text:{body:'menu'}}]}}]}]}));
const env=(extra={})=>({
 WABA_BUSINESSOS_DURABLE_WEBHOOK:'1',
 WABA_CHANNEL_PG_URL:process.env.R4_POSTGRES_TEST_URL||'postgresql://fake-host/offline',
 WABA_INBOX_AES256_KEY_HEX:KEY,WABA_APP_SECRET:SECRET,...extra
});
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
async function serve(app){
 const s=await new Promise(ok=>{const x=app.listen(0,'127.0.0.1',()=>ok(x));});
 return {url:'http://127.0.0.1:'+s.address().port,
  close:()=>new Promise(ok=>s.close(ok))};
}
const post=(s,bytes,sig)=>fetch(s.url+'/webhook',{method:'POST',
 headers:{'Content-Type':'application/json','X-Hub-Signature-256':sig},body:bytes});
test('H3 strict mode needs explicit exact flag; invalid values fail closed',()=>{
 assert.equal(durableMode({}),false);
 assert.equal(durableMode({WABA_BUSINESSOS_DURABLE_WEBHOOK:'0'}),false);
 assert.equal(durableMode({WABA_BUSINESSOS_DURABLE_WEBHOOK:'1'}),true);
 assert.throws(()=>durableMode({WABA_BUSINESSOS_DURABLE_WEBHOOK:'true'}),/MODE_INVALID/);
});
test('H3 invalid credentials refuse bootstrap before any DB connection',async()=>{
 let connected=0;
 class ForbiddenPool{constructor(){connected++;}}
 for(const v of [
  env({WABA_APP_SECRET:''}),env({WABA_CHANNEL_PG_URL:'wrong'}),
  env({WABA_INBOX_AES256_KEY_HEX:'abc'})
 ]){
  await assert.rejects(createDurableIngress({env:v,PoolClass:ForbiddenPool}),
   /CONFIG_INVALID/);
 }
 assert.equal(connected,0);
});
test('H3 missing schema prevents startup; no Meta HTTP listener opened',async()=>{
 let closed=0;
 class MissingSchemaPool{
  async query(){return {rowCount:1,rows:[{envelopes:null,inbox:null}]};}
  async end(){closed++;}
 }
 await assert.rejects(createDurableIngress({env:env(),PoolClass:MissingSchemaPool}),
  /INGRESS_NOT_READY/);
 assert.equal(closed,1);
});
test('H3 durable signature mismatch, DB error and 409 never acknowledge success',async()=>{
 let called=0;
 const inbox={isDurableSignedInbox:true,persistSignedEnvelope:async()=>({state:'CONFLICT'})};
 const s=await serve(createWebhookApp({appSecret:SECRET,durableInbox:inbox,
  onWebhook:async()=>{called++;}}));
 try{
  const bytes=raw('wamid.h3.A001');
  assert.equal((await post(s,bytes,sign(bytes))).status,409);
  assert.equal((await post(s,bytes,'sha256='+('0'.repeat(64)))).status,403);
  assert.equal(called,0);
 }finally{await s.close();}
});
test('H3 HTTP 200 is blocked until injected durable COMMIT completes',async()=>{
 let unblock,enter;
 const entered=new Promise(ok=>{enter=ok;});
 const gate=new Promise(ok=>{unblock=ok;});
 const inbox={isDurableSignedInbox:true,persistSignedEnvelope:async()=>{
  enter();await gate;return {state:'STORED'};
 }};
 const s=await serve(createWebhookApp({appSecret:SECRET,durableInbox:inbox,
  onWebhook:async()=>{throw Error('DIRECT_DISPATCH_FORBIDDEN');}}));
 try{
  const bytes=raw('wamid.h3.A002');
  let status='pending';
  const response=post(s,bytes,sign(bytes)).then(r=>{status=r.status;return r;});
  await entered;
  assert.equal(status,'pending');
  unblock();
  assert.equal((await response).status,200);
 }finally{await s.close();}
});
pgTest('H3 real PostgreSQL encrypted inbox persists before ACK; duplicate is idempotent',async()=>{
 const pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL});
 await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r5-channel.sql']);
 await pool.end();
 const boot=await createDurableIngress({env:env()});
 let sent=0;
 const s=await serve(createWebhookApp({appSecret:SECRET,durableInbox:boot.inbox,
  onWebhook:async()=>{sent++;}}));
 try{
  const bytes=raw('wamid.h3.POSTGRES.A003');
  assert.equal((await post(s,bytes,sign(bytes))).status,200);
  assert.equal((await post(s,bytes,sign(bytes))).status,200);
  assert.equal(sent,0);
  const p=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL});
  try{
   const result=await p.query('SELECT count(*)::int AS n FROM waba_channel.inbox WHERE message_id=$1',['wamid.h3.POSTGRES.A003']);
   assert.equal(result.rows[0].n,1);
   const digest=crypto.createHash('sha256').update(bytes).digest('hex');
   const rows=await p.query('SELECT ciphertext FROM waba_channel.signed_envelopes WHERE envelope_digest=$1',[digest]);
   assert.equal(rows.rowCount,1);
   assert.equal(rows.rows[0].ciphertext.includes(Buffer.from('menu')),false);
  }finally{await p.end();}
 }finally{await s.close();await boot.close();}
});
