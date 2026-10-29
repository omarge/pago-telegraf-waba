'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const protobuf=require('protobufjs');
const {TOPIC,inspectWire,createR12CanonicalWireGate}=require('../src/businessosR12CanonicalWireGate');
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const paymentId='waba-int-abc123',attempt='waba-att-abc123',tenant='tenant-waba-1';
const eventId='payment-engine:'+attempt+':PaymentCaptured';
const mk=(opts={})=>{
 const type=opts.type||'PaymentCaptured';
 const localEventId='payment-engine:'+attempt+':'+type+
  (type==='PaymentExecutionResolved'?':NOT_EXECUTED':'');
 const meta={eventId:localEventId,eventType:type,eventVersion:1,schemaVersion:1,
  producer:'payment-engine',tenantId:{id:tenant},
  source:{aggregateType:'Payment',aggregateId:attempt,version:0},
  idempotencyKey:attempt,correlationId:paymentId,causationId:attempt,
  orderingKey:paymentId,occurredAt:'2026-10-28T20:00:00Z'};
 const data={meta,paymentId,amount:{currency:{code:'MXN'},amountDecimal:'12.75'}};
 if(type==='PaymentAuthorized')data.status='PAYMENT_STATUS_AUTHORIZED';
 if(type==='PaymentFailed')data.status='OUTCOME_STATUS_FAILED';
 if(type==='PaymentExecutionUnknown'){
  data.paymentAttemptId=attempt;data.status='OUTCOME_STATUS_UNKNOWN';
 }
 if(type==='PaymentExecutionResolved'){
  data.paymentAttemptId=attempt;
  data.resolution='PAYMENT_EXECUTION_RESOLVED_NOT_EXECUTED';
 }
 const protobufType=root.lookupType('businessos.integration.v1.'+type);
 const wire=protobufType.encode(protobufType.fromObject(data)).finish();
 return {topic:TOPIC,key:Buffer.from(tenant+'|'+paymentId),value:Buffer.from(wire),
  headers:{'content-type':'application/x-protobuf','businessos-event-type':type,
   'businessos-event-id':localEventId,'businessos-tenant-id':tenant,
   'businessos-schema-version':'1','businessos-correlation-id':paymentId,
   'businessos-causation-id':attempt,'schema-artifact-id':'payment.proto'}};
};
test('R12 canonical: captured exact protobuf and secured-topic headers are candidate ONLY',()=>{
 const r=inspectWire(mk());
 assert.equal(r.state,'CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY');
 assert.equal(r.amountCents,1275);assert.equal(r.currency,'MXN');
 assert.equal(r.tenantId,tenant);assert.equal(r.paymentIntentId,paymentId);
 assert.equal(r.paymentAttemptId,attempt);assert.equal(r.eventId,eventId);
 assert.match(r.payloadDigest,/^[a-f0-9]{64}$/);
 assert.equal(r.isPaid,false);assert.equal(r.canSendReceipt,false);
});
test('R12 canonical: fail closed on topic, key, headers, forged tenant and invalid payload',()=>{
 const good=mk();
 for(const bad of [
  {...good,topic:'attacker.events.v1'},
  {...good,key:'tenant-foreign|'+paymentId},
  {...good,headers:{...good.headers,'businessos-tenant-id':'tenant-foreign'}},
  {...good,headers:{...good.headers,'businessos-event-id':'forged-event'}},
  {...good,headers:{...good.headers,'businessos-schema-version':'2'}},
  {...good,headers:{...good.headers,'schema-artifact-id':'random.proto'}},
  {...good,headers:{...good.headers,'content-type':'application/json'}},
  {...good,headers:{...good.headers,'businessos-correlation-id':'other-intent'}},
  {...good,headers:{...good.headers,'businessos-causation-id':'other-attempt'}},
  {...good,value:Buffer.from([0xff,0xff,0xff])},
  {...good,value:Buffer.alloc(65537)},
  {...good,value:Buffer.alloc(0)}
 ])assert.notEqual(inspectWire(bad).state,'CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY');
});
test('R12 canonical: tampered Payment payload metadata cannot be substituted by headers',()=>{
 const captured=root.lookupType('businessos.integration.v1.PaymentCaptured');
 const valid=mk();
 for(const metaChange of [
  {producer:'attacker'},
  {source:{aggregateType:'Treasury',aggregateId:attempt}},
  {orderingKey:'other'},
  {correlationId:'foreign'},
  {causationId:'foreign'},
  {schemaVersion:2},
  {eventVersion:2},
  {eventId:'payment-engine:foreign:PaymentCaptured'}
 ]){
  const decoded=captured.toObject(captured.decode(valid.value));
  Object.assign(decoded.meta,metaChange);
  const value=Buffer.from(captured.encode(captured.create(decoded)).finish());
  assert.notEqual(inspectWire({...valid,value}).state,'CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY');
 }
});
test('R12 canonical: precise MXN cents reject float, exponent, wrong currency and fractional subcent',()=>{
 const type=root.lookupType('businessos.integration.v1.PaymentCaptured'),valid=mk();
 for(const amountDecimal of ['12.755','1e2','NaN','-2.50','0.00','9007199254740999.00','12,75',' 12.75']){
  const decoded=type.toObject(type.decode(valid.value));
  decoded.amount.amountDecimal=amountDecimal;
  const value=Buffer.from(type.encode(type.create(decoded)).finish());
  assert.equal(inspectWire({...valid,value}).state,'INVALID_MONEY_HOLD',amountDecimal);
 }
 const decoded=type.toObject(type.decode(valid.value));
 decoded.amount.currency.code='USD';
 assert.equal(inspectWire({...valid,value:Buffer.from(type.encode(type.create(decoded)).finish())}).state,'INVALID_MONEY_HOLD');
});
test('R12 canonical: PaymentAuthorized, failed, refunded, UNKNOWN/RESOLVED never become capture',()=>{
 for(const type of ['PaymentAuthorized','PaymentFailed','PaymentRefunded',
  'PaymentExecutionUnknown','PaymentExecutionResolved']){
  const r=inspectWire(mk({type}));
  assert.notEqual(r.state,'CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY',type);
  assert.equal(r.state,'NON_CAPTURE_EVENT_HOLD',type);
 }
});
test('R12 canonical: disabled gate, forged transport and verifier exception always HOLD',async()=>{
 const g=mk();let calls=0;
 const disabled=createR12CanonicalWireGate({
  verifyTrustedTransport:async()=>{calls++;return true;}
 });
 assert.deepEqual(await disabled.inspect(g),{state:'DISABLED'});
 assert.equal(calls,0);
 assert.equal(disabled.isCaptureCertified,false);
 assert.equal(disabled.isLiveIntegrated,false);
 for(const validate of [async()=>false,async()=>{throw Error('private-secret');}]){
  const guard=createR12CanonicalWireGate({enabled:true,verifyTrustedTransport:validate});
  assert.deepEqual(await guard.inspect(g),{state:'UNVERIFIED_TRANSPORT_HOLD'});
 }
 const approved=createR12CanonicalWireGate({
  enabled:true,verifyTrustedTransport:async ctx=>{
   calls++;assert.equal(ctx.topic,TOPIC);
   assert.equal(ctx.eventId,eventId);
   return true;
  }});
 const result=await approved.inspect(g);
 assert.equal(result.state,'CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY');
 assert.equal(result.canSendReceipt,false);assert.equal(calls,1);
});
