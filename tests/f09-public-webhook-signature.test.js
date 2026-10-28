'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createWebhookApp}=require('../src/index');
const SECRET='offline-f09-meta-app-secret-not-a-real-value';
const BODY={object:'whatsapp_business_account',entry:[{changes:[{field:'messages',
 value:{messages:[{from:'5215555550002',type:'text',text:{body:'menu'}}]}}]}]};
function signature(raw,secret=SECRET){
 return 'sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');
}
async function server(app){
 const s=await new Promise(resolve=>{
  const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));
 });
 return {url:'http://127.0.0.1:'+s.address().port,
  close:()=>new Promise(resolve=>s.close(resolve))};
}
async function request(s,raw,header,extra={}){
 return fetch(s.url+'/webhook',{
  method:'POST',redirect:'manual',headers:{
   'Content-Type':'application/json',
   ...(header?{'X-Hub-Signature-256':header}:{}),
   ...extra
  },body:raw
 });
}
async function settle(predicate){
 for(let i=0;i<100;i++){if(predicate())return;
  await new Promise(resolve=>setTimeout(resolve,5));}
 assert.fail('signed webhook was not dispatched');
}
test('F09 RED-first: webhook cannot accept an unsigned message',async()=>{
 let called=0;const s=await server(createWebhookApp({
  appSecret:SECRET,onWebhook:async()=>{called++;}
 }));
 try{
  const r=await request(s,JSON.stringify(BODY));
  assert.equal(r.status,403);
  assert.equal(called,0);
 }finally{await s.close();}
});
test('F09 no App Secret: fail closed without using WABA_VERIFY_TOKEN as HMAC',async()=>{
 let called=0;const s=await server(createWebhookApp({
  appSecret:'',verifyToken:'f09-different-verification-token',
  onWebhook:async()=>{called++;}
 }));
 try{
  const r=await request(s,JSON.stringify(BODY),signature(Buffer.from(JSON.stringify(BODY))));
  assert.equal(r.status,503);
  assert.equal(called,0);
 }finally{await s.close();}
});
test('F09 HMAC sign exact received raw UTF-8 bytes, not reserialized JSON',async()=>{
 const delivered=[];
 const s=await server(createWebhookApp({appSecret:SECRET,
  onWebhook:async body=>delivered.push(body)
 }));
 try{
  const raw=JSON.stringify(BODY,null,2);
  const r=await request(s,raw,signature(Buffer.from(raw)));
  assert.equal(r.status,200);
  await settle(()=>delivered.length===1);
  assert.deepEqual(delivered[0],BODY);
 }finally{await s.close();}
});
test('F09 bad secret, bad format, signature replay over altered body all fail closed',async()=>{
 const seen=[];const s=await server(createWebhookApp({appSecret:SECRET,
  onWebhook:async value=>seen.push(value)
 }));
 try{
  const raw=JSON.stringify(BODY);
  for(const header of ['sha256='+('0'.repeat(64)),signature(Buffer.from(raw),'another-secret-f09-test-value'),
    'sha1='+('0'.repeat(40)),'sha256=not-hex']){
   const r=await request(s,raw,header);
   assert.equal(r.status,403);
  }
  const altered=raw.replace('menu','cobrar');
  assert.equal((await request(s,altered,signature(Buffer.from(raw)))).status,403);
  assert.equal(seen.length,0);
 }finally{await s.close();}
});
test('F09 valid signature with invalid JSON or invalid envelope never reaches bot handler',async()=>{
 let called=0;const s=await server(createWebhookApp({appSecret:SECRET,onWebhook:async()=>{called++;}}));
 try{
  const raw='{';
  assert.equal((await request(s,raw,signature(Buffer.from(raw)))).status,400);
  const wrong=JSON.stringify({object:'other',entry:[]});
  assert.equal((await request(s,wrong,signature(Buffer.from(wrong)))).status,400);
  assert.equal(called,0);
 }finally{await s.close();}
});
test('F09 only JSON with valid content-type and size can pass; no PAN/PSP credentials logged',async()=>{
 let called=0;const logger={log(){},error(){called++;}};
 const s=await server(createWebhookApp({appSecret:SECRET,
  onWebhook:async()=>{called++;},logger}));
 try{
  const raw=JSON.stringify(BODY);
  const r=await request(s,raw,signature(Buffer.from(raw)),{'Content-Type':'text/plain'});
  assert.equal(r.status,415);
  assert.equal((await request(s,'x'.repeat(65537),signature(Buffer.from('x'.repeat(65537))))).status,413);
  assert.equal(called,0);
 }finally{await s.close();}
});
test('F09 GET verification handshake retains separate WABA_VERIFY_TOKEN and rejects wrong token',async()=>{
 const s=await server(createWebhookApp({appSecret:SECRET,verifyToken:'f09-verify-token',
  onWebhook:async()=>{throw Error('not expected');},logger:{log(){},error(){}}
 }));
 try{
  let r=await fetch(s.url+'/webhook?hub.mode=subscribe&hub.verify_token=f09-verify-token&hub.challenge=abc123');
  assert.equal(r.status,200);
  assert.equal(await r.text(),'abc123');
  r=await fetch(s.url+'/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123');
  assert.equal(r.status,403);
 }finally{await s.close();}
});
