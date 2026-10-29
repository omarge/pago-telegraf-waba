'use strict';
// Independent hardening of canonical NON-CAPTURE event ownership.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const protobuf=require('protobufjs');
const {TOPIC,inspectWire}=require('../src/businessosR12CanonicalWireGate');
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');root.resolveAll();
const ATTEMPT='waba-att-c-identity',INTENT='waba-int-c-identity',TENANT='tenant-c-identity';
const TYPES=['PaymentAuthorized','PaymentFailed','PaymentRefunded',
 'PaymentExecutionUnknown','PaymentExecutionResolved'];
function wire(kind,metadata={},extra={}){
 const suffix=kind==='PaymentExecutionResolved'?':EXECUTED':'';
 const eventId='payment-engine:'+ATTEMPT+':'+kind+suffix;
 const meta={eventId,eventType:kind,tenantId:{id:TENANT},
  source:{aggregateType:'Payment',aggregateId:ATTEMPT},
  producer:'payment-engine',idempotencyKey:ATTEMPT,
  correlationId:INTENT,causationId:ATTEMPT,orderingKey:INTENT,
  eventVersion:1,schemaVersion:1,occurredAt:'2026-10-28T22:11:12Z',...metadata};
 const payload={meta,paymentId:INTENT,
  amount:{currency:{code:'MXN'},amountDecimal:'12.75'},...extra};
 if(kind==='PaymentAuthorized')payload.status=extra.status??'PAYMENT_STATUS_AUTHORIZED';
 if(kind==='PaymentFailed')payload.status=extra.status??'OUTCOME_STATUS_FAILED';
 if(kind==='PaymentExecutionUnknown'){
  payload.paymentAttemptId=extra.paymentAttemptId??ATTEMPT;
  payload.status=extra.status??'OUTCOME_STATUS_UNKNOWN';
 }
 if(kind==='PaymentExecutionResolved'){
  payload.paymentAttemptId=extra.paymentAttemptId??ATTEMPT;
  payload.resolution=extra.resolution??'PAYMENT_EXECUTION_RESOLVED_EXECUTED';
 }
 const type=root.lookupType('businessos.integration.v1.'+kind);
 return {topic:TOPIC,key:Buffer.from(TENANT+'|'+INTENT),
  headers:{
   'content-type':'application/x-protobuf',
   'businessos-event-type':kind,'businessos-event-id':meta.eventId,
   'businessos-tenant-id':TENANT,'businessos-schema-version':'1',
   'businessos-correlation-id':INTENT,'businessos-causation-id':ATTEMPT,
   'schema-artifact-id':'payment.proto'
  },
  value:Buffer.from(type.encode(type.fromObject(payload)).finish())
 };
}
test('R12-C all real owner noncapture event IDs remain HOLD, not capture/PAID',()=>{
 for(const kind of TYPES){
  const out=inspectWire(wire(kind));
  assert.equal(out.state,'NON_CAPTURE_EVENT_HOLD',kind);
  assert.equal(out.eventType,kind);
  assert.equal(out.isPaid,false);
  assert.equal(out.canSendReceipt,false);
 }
});
test('R12-C forged event_id with self-consistent Kafka header fails owner identity',()=>{
 for(const kind of TYPES){
  const bad=wire(kind,{eventId:'payment-engine:attacker:'+kind});
  assert.equal(inspectWire(bad).state,'CANONICAL_METADATA_MISMATCH_HOLD',kind);
 }
});
test('R12-C source attempt identity invalid or foreign is blocked before durable noncapture audit',()=>{
 for(const kind of TYPES){
  const bad=wire(kind,{source:{aggregateType:'Payment',aggregateId:'foreign-attempt'}});
  assert.equal(inspectWire(bad).state,'CANONICAL_METADATA_MISMATCH_HOLD',kind);
 }
});
test('R12-C unknown and resolved require same embedded attempt as meta.source',()=>{
 for(const kind of ['PaymentExecutionUnknown','PaymentExecutionResolved']){
  const bad=wire(kind,{}, {paymentAttemptId:'foreign-attempt'});
  assert.equal(inspectWire(bad).state,'CANONICAL_METADATA_MISMATCH_HOLD',kind);
 }
});
test('R12-C execution resolution suffix must match actual protobuf economic result',()=>{
 const bad=wire('PaymentExecutionResolved',{},{
  resolution:'PAYMENT_EXECUTION_RESOLVED_NOT_EXECUTED'
 });
 assert.equal(inspectWire(bad).state,'CANONICAL_METADATA_MISMATCH_HOLD');
});
test('R12-C unknown status cannot be forged as OK or FAILED',()=>{
 for(const status of ['OUTCOME_STATUS_OK','OUTCOME_STATUS_FAILED']){
  const bad=wire('PaymentExecutionUnknown',{},{status});
  assert.equal(inspectWire(bad).state,'CANONICAL_METADATA_MISMATCH_HOLD',status);
 }
});
test('R12-C fake authorized/failed status cannot be treated as canonical audit fact',()=>{
 for(const [kind,status] of [
  ['PaymentAuthorized','PAYMENT_STATUS_FAILED'],
  ['PaymentFailed','OUTCOME_STATUS_OK']
 ]){
  const bad=wire(kind,{}, {status});
  assert.equal(inspectWire(bad).state,'CANONICAL_METADATA_MISMATCH_HOLD',kind);
 }
});
