'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {createPostgresChannelStore,digestEvent}=
 require('../src/businessosPgChannelStore');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const req=n=>'KPR-'+n.repeat(32);
const requester='5215555550002',payer='waba-payer-r4';
const hash=data=>digestEvent(data);
let pool,store;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:12});
  await pool.query(fs.readFileSync(
   path.resolve(__dirname,'../db/waba-r4-channel.sql'),'utf8'));
  store=createPostgresChannelStore({pool});
 });
 after(async()=>{if(pool)await pool.end();});
}
pgTest('R4 PostgreSQL idempotent request creation and conflict on economic change',async()=>{
 const a=req('A');
 assert.deepEqual(await store.createRequest({requestId:a,requesterId:requester,amountCents:1250}),{state:'CREATED'});
 assert.deepEqual(await store.createRequest({requestId:a,requesterId:requester,amountCents:1250}),{state:'DUPLICATE'});
 assert.equal((await store.createRequest({requestId:a,requesterId:requester,amountCents:9999})).state,'CONFLICT');
 const v=await store.getRequest(a);
 assert.equal(v.amount,1250);
 assert.equal(v.payerAccountId,null);
 assert.equal(Object.isFrozen(v),true);
});
pgTest('R4 invalid amount/identifier never enters database',async()=>{
 const a=req('B');
 for(const input of [
  {requestId:a,requesterId:requester,amountCents:0},
  {requestId:a,requesterId:requester,amountCents:1.1},
  {requestId:'forged',requesterId:requester,amountCents:100},
  {requestId:a,requesterId:'other',amountCents:100}
 ]){
  assert.equal((await store.createRequest(input)).state,'INVALID');
 }
 assert.equal(await store.getRequest(a),null);
});
pgTest('R4 server-side payer binding is compare-and-set and immutable',async()=>{
 const a=req('C');
 await store.createRequest({requestId:a,requesterId:requester,amountCents:1001});
 assert.equal((await store.bindPayer({requestId:a,payerAccountId:payer,
  requesterId:requester,amountCents:1001})).state,'BOUND');
 assert.equal((await store.bindPayer({requestId:a,payerAccountId:payer,
  requesterId:requester,amountCents:1001})).state,'ALREADY_BOUND');
 assert.equal((await store.bindPayer({requestId:a,payerAccountId:'thief',
  requesterId:requester,amountCents:1001})).state,'CONFLICT');
 assert.equal((await store.bindPayer({requestId:a,payerAccountId:payer,
  requesterId:requester,amountCents:3000})).state,'CONFLICT');
 assert.equal((await store.getRequest(a)).payerAccountId,payer);
});
pgTest('R4 two concurrent processes claiming same request: only one binding wins',async()=>{
 const a=req('D');await store.createRequest({requestId:a,requesterId:requester,amountCents:1002});
 const other=createPostgresChannelStore({pool});
 const [first,second]=await Promise.all([
  store.bindPayer({requestId:a,payerAccountId:'payer-alpha',requesterId:requester,amountCents:1002}),
  other.bindPayer({requestId:a,payerAccountId:'payer-beta',requesterId:requester,amountCents:1002})
 ]);
 assert.deepEqual([first.state,second.state].sort(),['BOUND','CONFLICT']);
 assert.ok(['payer-alpha','payer-beta'].includes((await store.getRequest(a)).payerAccountId));
});
pgTest('R4 inbox deduplicates signed message, fails closed on collision',async()=>{
 const item={phoneNumberId:'1478834131971433',messageId:'wamid.r4.message.AAA',
  kind:'MESSAGE',eventDigest:hash({id:'wamid.r4.message.AAA',body:'cobrar'}),
  signatureVerified:true};
 assert.equal((await store.admitSignedEvent({...item,signatureVerified:false})).state,'UNVERIFIED');
 assert.equal((await store.admitSignedEvent(item)).state,'ACCEPTED');
 assert.equal((await store.admitSignedEvent(item)).state,'DUPLICATE');
 assert.equal((await store.admitSignedEvent({...item,eventDigest:hash({body:'pagar'})})).state,'CONFLICT');
 const count=await pool.query('SELECT count(*)::int AS n FROM waba_channel.inbox WHERE message_id=$1',[item.messageId]);
 assert.equal(count.rows[0].n,1);
});
pgTest('R4 signed status kinds are unique per status; duplicate callbacks never enqueue twice',async()=>{
 const id='wamid.r4.status.BBB',phone='1478834131971433';
 for(const kind of ['STATUS_SENT','STATUS_DELIVERED','STATUS_READ']){
  assert.equal((await store.admitSignedEvent({
   phoneNumberId:phone,messageId:id,kind,
   eventDigest:hash({id,kind}),signatureVerified:true
  })).state,'ACCEPTED');
  assert.equal((await store.admitSignedEvent({
   phoneNumberId:phone,messageId:id,kind,
   eventDigest:hash({id,kind}),signatureVerified:true
  })).state,'DUPLICATE');
 }
 const count=await pool.query('SELECT count(*)::int AS n FROM waba_channel.inbox WHERE message_id=$1',[id]);
 assert.equal(count.rows[0].n,3);
});
pgTest('R4 concurrent authorization reservations are single-shot across workers',async()=>{
 const a=req('E');
 await store.createRequest({requestId:a,requesterId:requester,amountCents:2999});
 await store.bindPayer({requestId:a,payerAccountId:payer,requesterId:requester,amountCents:2999});
 const request={requestId:a,payerAccountId:payer,idempotencyKey:'waba-r4-single-shot-authorization-0001'};
 const workers=Array.from({length:8},()=>createPostgresChannelStore({pool}));
 const result=await Promise.all(workers.map(s=>s.reserveAuthorization(request)));
 assert.equal(result.filter(x=>x.state==='RESERVED_NO_AUTO_RETRY').length,1);
 assert.equal(result.filter(x=>x.state==='HOLD_NO_AUTO_RETRY').length,7);
 assert.equal((await store.reserveAuthorization(request)).state,'HOLD_NO_AUTO_RETRY');
 const count=await pool.query('SELECT count(*)::int AS n FROM waba_channel.authorization_reservations WHERE request_id=$1',[a]);
 assert.equal(count.rows[0].n,1);
});
pgTest('R4 owner and pending checks prevent reservation, even with valid idempotency key',async()=>{
 const a=req('F');
 await store.createRequest({requestId:a,requesterId:requester,amountCents:1900});
 const key='waba-r4-deny-reservation-000001';
 assert.equal((await store.reserveAuthorization({requestId:a,payerAccountId:'attacker',idempotencyKey:key})).state,'NOT_FOUND');
 await store.bindPayer({requestId:a,payerAccountId:payer,requesterId:requester,amountCents:1900});
 assert.equal((await store.reserveAuthorization({requestId:a,payerAccountId:'attacker',idempotencyKey:key})).state,'NOT_FOUND');
 await pool.query('UPDATE waba_channel.requests SET state=$2 WHERE request_id=$1',[a,'BLOCKED']);
 assert.equal((await store.reserveAuthorization({requestId:a,payerAccountId:payer,idempotencyKey:key})).state,'NOT_PENDING');
});
pgTest('R4 Postgres reconnect retains requests, inbox and single-shot reserve',async()=>{
 const a=req('G');
 await store.createRequest({requestId:a,requesterId:requester,amountCents:500});
 await store.bindPayer({requestId:a,payerAccountId:payer,requesterId:requester,amountCents:500});
 const key='waba-r4-restart-reservation-000001';
 assert.equal((await store.reserveAuthorization({requestId:a,payerAccountId:payer,idempotencyKey:key})).state,'RESERVED_NO_AUTO_RETRY');
 const otherPool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const reopened=createPostgresChannelStore({pool:otherPool});
  assert.equal((await reopened.getRequest(a)).payerAccountId,payer);
  assert.equal((await reopened.reserveAuthorization({requestId:a,payerAccountId:payer,idempotencyKey:key})).state,'HOLD_NO_AUTO_RETRY');
 }finally{await otherPool.end();}
});
