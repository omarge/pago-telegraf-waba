'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createR12CaptureObservationGate}=require('../src/businessosR12CaptureObservationGate');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const TENANT='tenant-r12-ci',PAYER='payer-r12-ci',OTHER='outsider-r12-ci';
const INTENT='waba-int-r12-canonical',ATTEMPT='waba-att-r12-canonical';
let serial=0,pool;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:14});
  await applyTestChannelMigrations(pool,['waba-r4-channel.sql','waba-r11-channel.sql']);
 });
 after(async()=>{if(pool)await pool.end();});
}
const observation=()=>({
 tenantId:TENANT,paymentIntentId:INTENT,paymentAttemptId:ATTEMPT,
 amountCents:1275,currency:'MXN',intentStatus:'CAPTURED',
 attemptStatus:'CAPTURED',providerOutcomeStatus:'CAPTURED',
 reconciliationFindingType:'MATCHED'
});
async function setup(outcome='AUTHORIZED_PENDING_CAPTURE'){
 const n=++serial,requestId='KPR-'+n.toString(16).toUpperCase().padStart(32,'0');
 const key='waba-r12-key-'+n;
 await pool.query('INSERT INTO waba_channel.requests '+
  '(request_id,requester_wa_id,amount_cents,payer_account_id) VALUES($1,$2,$3,$4)',
  [requestId,'5215555550002',1275,PAYER]);
 await pool.query('INSERT INTO waba_channel.authorization_reservations '+
  '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3)',
  [requestId,PAYER,key]);
 await pool.query('INSERT INTO waba_channel.payment_authorization_handoffs '+
  '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
  'amount_cents,idempotency_key,authority_fingerprint,outcome,'+
  'businessos_intent_id,businessos_attempt_id,finalized_at) '+
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $9='UNKNOWN_HOLD' THEN NULL ELSE clock_timestamp() END)",
  [requestId,PAYER,TENANT,'customer-r12-ci','11111111-2222-4333-8444-555555555555',
   1275,key,'a'.repeat(64),outcome,
   outcome==='UNKNOWN_HOLD'?null:INTENT,outcome==='UNKNOWN_HOLD'?null:ATTEMPT]);
 return requestId;
}
function gate(reader=async()=>observation()){
 const calls=[];
 return {calls,gate:createR12CaptureObservationGate({enabled:true,pool,
  readAuthoritativeObservation:async ctx=>{calls.push(ctx);return reader(ctx);}
 })};
}
test('R12 disabled and invalid requests fail before both trusted ports',async()=>{
 let n=0;
 const p={query:async()=>{n++;throw Error('no database');}};
 const reader=async()=>{n++;throw Error('no remote');};
 const disabled=createR12CaptureObservationGate({pool:p,readAuthoritativeObservation:reader});
 assert.deepEqual(await disabled.probe({}),{state:'DISABLED'});
 assert.equal(disabled.isLiveIntegrated,false);
 assert.equal(disabled.isCaptureCertified,false);
 assert.equal(disabled.isNotificationDispatcher,false);
 const enabled=createR12CaptureObservationGate({enabled:true,pool:p,readAuthoritativeObservation:reader});
 for(const requestId of ['malformed','KPR-'+'G'.repeat(32),null,{}])
  assert.deepEqual(await enabled.probe({requestId,accountId:PAYER}),{state:'INVALID'});
 assert.equal(n,0);
});
pgTest('R12 perfectly matched capture candidate never becomes PAID or receipt',async()=>{
 const requestId=await setup(),f=gate();
 const got=await f.gate.probe({requestId,accountId:PAYER});
 assert.deepEqual(got,{state:'CAPTURE_EVIDENCE_CANDIDATE_OFFLINE_ONLY',
  isPaid:false,isCaptureCertified:false,canSendReceipt:false,canSendWhatsApp:false});
 assert.deepEqual(f.calls,[{tenantId:TENANT,paymentIntentId:INTENT,
  paymentAttemptId:ATTEMPT,amountCents:1275,currency:'MXN',requestId}]);
 assert.equal((await pool.query('SELECT outcome FROM waba_channel.payment_authorization_handoffs WHERE request_id=$1',
  [requestId])).rows[0].outcome,'AUTHORIZED_PENDING_CAPTURE');
});
pgTest('R12 wrong payer, missing row and UNKNOWN handoff never invoke reader',async()=>{
 const requestId=await setup(),unknown=await setup('UNKNOWN_HOLD'),f=gate();
 for(const args of [
  {requestId,accountId:OTHER},{requestId:unknown,accountId:PAYER},
  {requestId:'KPR-'+'F'.repeat(32),accountId:PAYER}
 ])assert.equal((await f.gate.probe(args)).state,'NOT_ELIGIBLE_NO_EFFECT');
 assert.equal(f.calls.length,0);
});
pgTest('R12 cross tenant, foreign IDs, amount and currency cannot confirm capture',async()=>{
 const requestId=await setup();
 for(const mutation of [
  {tenantId:'other'},{paymentIntentId:'foreign'},{paymentAttemptId:'foreign'},
  {amountCents:1276},{amountCents:12.75},{currency:'USD'}
 ]){
  const result=await gate(async()=>({...observation(),...mutation})).gate.probe({requestId,accountId:PAYER});
  assert.equal(result.state,'OBSERVATION_MISMATCH_HOLD',JSON.stringify(mutation));
  assert.equal(result.isPaid,false);
 }
});
pgTest('R12 partial/authorized/unknown/contradictory statuses all HOLD',async()=>{
 const requestId=await setup();
 for(const mutation of [
  {intentStatus:'AUTHORIZED'},{intentStatus:'PARTIALLY_CAPTURED'},
  {intentStatus:'REFUNDED'},{intentStatus:'DISPUTED'},
  {attemptStatus:'UNKNOWN'},{attemptStatus:'AUTHORIZED'},
  {providerOutcomeStatus:'UNKNOWN'},{providerOutcomeStatus:'AUTHORIZED'},
  {reconciliationFindingType:'AMOUNT_MISMATCH'},
  {reconciliationFindingType:'LOCAL_CAPTURED_PROVIDER_NOT_CAPTURED'},
  {reconciliationFindingType:'EVIDENCE_TEMPORARILY_UNAVAILABLE'},
  {reconciliationFindingType:null}
 ]){
  const result=await gate(async()=>({...observation(),...mutation})).gate.probe({requestId,accountId:PAYER});
  assert.equal(result.state,'OBSERVATION_NOT_FINAL_HOLD',JSON.stringify(mutation));
  assert.equal(result.canSendReceipt,false);
 }
});
pgTest('R12 unavailable source or malformed observation cannot become PAID',async()=>{
 const requestId=await setup();
 assert.equal((await gate(async()=>{throw Error('private PSP secret');}).gate.probe({requestId,accountId:PAYER})).state,'OBSERVATION_UNAVAILABLE_HOLD');
 for(const response of [null,[],false]){
  assert.equal((await gate(async()=>response).gate.probe({requestId,accountId:PAYER})).state,'UNAVAILABLE_HOLD_NO_EFFECT');
 }
});
pgTest('R12 rejects handoff changed during external await',async()=>{
 const requestId=await setup();
 let release,entered;
 const signal=new Promise(done=>{entered=done;});
 const g=gate(async()=>{
  entered();
  return new Promise(done=>{release=()=>done(observation());});
 });
 const task=g.gate.probe({requestId,accountId:PAYER});
 await signal;
 await pool.query('UPDATE waba_channel.payment_authorization_handoffs SET amount_cents=amount_cents+1 WHERE request_id=$1',[requestId]);
 release();
 assert.equal((await task).state,'HANDOFF_CHANGED_HOLD');
});
test('R12 DB outage is safe and does not invoke the economic observation source',async()=>{
 let calls=0;
 const g=createR12CaptureObservationGate({enabled:true,
  pool:{query:async()=>{throw Error('private postgresql key');}},
  readAuthoritativeObservation:async()=>{calls++;return observation();}});
 assert.deepEqual(await g.probe({requestId:'KPR-'+'A'.repeat(32),accountId:PAYER}),
  {state:'DB_UNAVAILABLE_NO_EFFECT'});
 assert.equal(calls,0);
});
