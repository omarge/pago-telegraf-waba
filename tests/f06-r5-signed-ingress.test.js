'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createEvidenceLedger}=require('../src/f06EvidenceLedger');
const {createIsolatedStatusApp}=require('../src/f06IsolatedStatusApp');
const secret='F06_mock_Meta_AppSecret_not_actual_key_01234';
const phoneId='1478834131971433',payer='5215512345678',collector='5215543964378';
const idP='wamid.f06.payer.12345',idC='wamid.f06.collector.45678';
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f06-r5-'));
 const filePath=path.join(dir,'private','evidence.json');
 const opts={filePath,appSecret:secret,phoneId};
 const ledger=()=>createEvidenceLedger(opts);
 const close=()=>fs.rmSync(dir,{recursive:true,force:true});
 return {dir,filePath,ledger,close};
}
function accept(ledger,role,id,recipient){
 return ledger.recordAcceptance({role,recipient,metaResponse:{messages:[{id}]}});
}
function signedPayload(events,{sender=phoneId}={}){
 const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',
  entry:[{changes:[{field:'messages',value:{
   metadata:{phone_number_id:sender},statuses:events
  }}]}]}));
 const signature='sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');
 return {raw,signature};
}
function state(id,status,to,timestamp='1780000001'){
 return {id,status,recipient_id:to,timestamp};
}
async function server(app){
 const listening=await new Promise(done=>{
  const s=app.listen(0,'127.0.0.1',()=>done(s));
 });
 return {url:'http://127.0.0.1:'+listening.address().port,
  close:()=>new Promise(done=>listening.close(done))};
}
async function post(s,p,header){
 return fetch(s.url+'/f06/status',{method:'POST',redirect:'manual',
  headers:{'Content-Type':'application/json',
   ...(header===undefined?{'X-Hub-Signature-256':p.signature}:
       header?{'X-Hub-Signature-256':header}:{})},body:p.raw});
}
test('F06 R5 signed HTTP statuses persist and recover after restart without repost',async()=>{
 const f=fixture();
 try{
  const l=f.ledger();
  accept(l,'PAYER',idP,payer);
  accept(l,'COLLECTOR',idC,collector);
  const app=createIsolatedStatusApp({ledger:l}),s=await server(app);
  try{
   const payload=signedPayload([
    state(idP,'delivered','525512345678'),
    state(idC,'read','525543964378')
   ]);
   const r=await post(s,payload);
   assert.equal(r.status,200);
   assert.deepEqual(await r.json(),{ok:true,updates:2});
   assert.equal(l.summary().evidenceBilateralDelivered,true);
   const fstat=fs.statSync(f.filePath);
   assert.equal(fstat.mode&0o077,0);
   const recovered=f.ledger();
   assert.equal(recovered.summary().evidenceBilateralDelivered,true);
   assert.equal(recovered.summary().states.delivered,1);
   assert.equal(recovered.summary().states.read,1);
  }finally{await s.close();}
 }finally{f.close();}
});
test('F06 R5 invalid/absent signature rejects HTTP and never persists an update',async()=>{
 const f=fixture();
 try{
  const l=f.ledger();accept(l,'PAYER',idP,payer);
  const before=fs.readFileSync(f.filePath);
  const s=await server(createIsolatedStatusApp({ledger:l}));
  try{
   const packet=signedPayload([state(idP,'delivered','525512345678')]);
   assert.equal((await post(s,packet,'')).status,403);
   assert.equal((await post(s,packet,'sha256='+('0'.repeat(64)))).status,403);
   assert.deepEqual(fs.readFileSync(f.filePath),before);
   assert.equal(f.ledger().summary().states.ACCEPTED_BY_META,1);
  }finally{await s.close();}
 }finally{f.close();}
});
test('F06 R5 duplicate and stale status replay never reduces delivery, survives recovery',async()=>{
 const f=fixture();
 try{
  const l=f.ledger();accept(l,'PAYER',idP,payer);
  const delivered=signedPayload([state(idP,'delivered','525512345678')]);
  assert.equal(l.ingestSignedStatus({rawBody:delivered.raw,signature:delivered.signature}).updated,1);
  const before=fs.readFileSync(f.filePath);
  assert.equal(l.ingestSignedStatus({rawBody:delivered.raw,signature:delivered.signature}).duplicate,1);
  const stale=signedPayload([state(idP,'sent','525512345678')]);
  assert.equal(l.ingestSignedStatus({rawBody:stale.raw,signature:stale.signature}).ignored,1);
  assert.deepEqual(fs.readFileSync(f.filePath),before);
  assert.equal(f.ledger().summary().states.delivered,1);
 }finally{f.close();}
});
test('F06 R5 ledger tampering is detected, not silently accepted as delivered',()=>{
 const f=fixture();
 try{
  const l=f.ledger();accept(l,'PAYER',idP,payer);
  const raw=fs.readFileSync(f.filePath,'utf8').replace('ACCEPTED_BY_META','delivered');
  fs.writeFileSync(f.filePath,raw,{mode:0o600});
  assert.throws(()=>f.ledger(),/F06_LEDGER_INTEGRITY_FAILURE/);
 }finally{f.close();}
});
test('F06 R5 unsafe file permissions cause fail-closed recovery',()=>{
 const f=fixture();
 try{
  const l=f.ledger();accept(l,'PAYER',idP,payer);
  fs.chmodSync(f.filePath,0o644);
  assert.throws(()=>f.ledger(),/F06_LEDGER_UNSAFE_FILE/);
 }finally{f.close();}
});
test('F06 R5 Meta acceptance ID collision and test override are blocked',()=>{
 const f=fixture();
 try{
  const l=f.ledger();accept(l,'PAYER',idP,payer);
  assert.throws(()=>accept(l,'COLLECTOR',idP,collector),/F06_ACCEPTANCE_CONFLICT/);
  assert.throws(()=>createEvidenceLedger({
   filePath:f.filePath,appSecret:secret,phoneId,testToOverride:'525555555555'
  }),/F06_TEST_TO_OVERRIDE_ACTIVE/);
 }finally{f.close();}
});
test('F06 R5 exposed ingress does not trigger a message, charge or modify live webhooks',async()=>{
 const f=fixture();
 try{
  const l=f.ledger(),s=await server(createIsolatedStatusApp({ledger:l}));
  try{
   const r=await fetch(s.url+'/f06/status');
   assert.equal(r.status,404);
   assert.equal(l.summary().tracked,0);
   assert.equal(l.summary().isLiveIntegrated,false);
  }finally{await s.close();}
 }finally{f.close();}
});
test('F06 R5 invalid envelope fails closed without leaking stored destinations',async()=>{
 const f=fixture();
 try{
  const l=f.ledger();accept(l,'PAYER',idP,payer);
  const s=await server(createIsolatedStatusApp({ledger:l}));
  try{
   const raw=Buffer.from(JSON.stringify({object:'forged',entry:[]}));
   const signature='sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');
   const r=await post(s,{raw,signature});
   assert.equal(r.status,400);
   const body=await r.text();
   assert.ok(!body.includes(payer));
  }finally{await s.close();}
 }finally{f.close();}
});
