'use strict';
// R12 OFFLINE: validates REAL Payment Engine canonical protobuf wire bytes.
// No Kafka client, no financial updates, no Meta dispatch, no PAID.
// A trusted secured-broker adapter is NOT IMPLEMENTED here.
const crypto=require('node:crypto');
const path=require('node:path');
const protobuf=require('protobufjs');
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.resolve(__dirname,'../contracts',target);
root.loadSync('businessos/integration/v1/payment.proto');
root.resolveAll();
const TOPIC='businessos.payment.events.v1';
const EVENT_TYPES=Object.freeze({
 PaymentCaptured:'PaymentCaptured',
 PaymentAuthorized:'PaymentAuthorized',
 PaymentExecutionUnknown:'PaymentExecutionUnknown',
 PaymentExecutionResolved:'PaymentExecutionResolved',
 PaymentRefunded:'PaymentRefunded',
 PaymentFailed:'PaymentFailed'
});
const HOLD_EVENTS=new Set(Object.keys(EVENT_TYPES).filter(x=>x!=='PaymentCaptured'));
const HEX=/^[a-f0-9]{64}$/;
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KNOWN_HEADERS=[
 'content-type','businessos-event-type','businessos-event-id','businessos-tenant-id',
 'businessos-schema-version','businessos-correlation-id','businessos-causation-id',
 'schema-artifact-id'
];
function utf8(value){
 if(typeof value==='string')return value;
 if(!Buffer.isBuffer(value))return null;
 try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch(_e){return null;}
}
function headersFor(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const parsed={};
 for(const k of KNOWN_HEADERS){
  if(!Object.prototype.hasOwnProperty.call(raw,k))return null;
  const s=utf8(raw[k]);
  if(s===null)return null;
  parsed[k]=s;
 }
 return parsed;
}
function centsExact(decimal,currency){
 if(currency!=='MXN'||typeof decimal!=='string'||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(decimal))
  return null;
 const [whole,minor='']=decimal.split('.');
 const amount=BigInt(whole)*100n+BigInt(minor.padEnd(2,'0')||'0');
 if(amount<=0n||amount>BigInt(Number.MAX_SAFE_INTEGER))return null;
 return Number(amount);
}
function inspectWire({topic,key,headers,value}={}){
 if(topic!==TOPIC||!Buffer.isBuffer(value)||value.length===0||value.length>65536)
  return {state:'INVALID_WIRE_HOLD'};
 const keyText=utf8(key),h=headersFor(headers);
 if(!h||h['content-type']!=='application/x-protobuf'||
    h['businessos-schema-version']!=='1'||
    h['schema-artifact-id']!=='payment.proto'||!keyText)
  return {state:'INVALID_WIRE_HOLD'};
 const type=h['businessos-event-type'];
 if(!Object.prototype.hasOwnProperty.call(EVENT_TYPES,type))
  return {state:'UNSUPPORTED_EVENT_HOLD'};
 let event,meta;
 try{
  const decoder=root.lookupType('businessos.integration.v1.'+type);
  const decoded=decoder.decode(value);
  if(decoder.verify(decoded)!==null)return {state:'INVALID_WIRE_HOLD'};
  event=decoder.toObject(decoded,{enums:String,longs:String,bytes:Buffer});
  meta=event.meta;
 }catch(_e){return {state:'INVALID_WIRE_HOLD'};}
 if(!meta||meta.producer!=='payment-engine'||meta.eventType!==type||
    meta.eventVersion!==1||meta.schemaVersion!==1||
    meta.source?.aggregateType!=='Payment'||!meta.source.aggregateId||
    meta.tenantId?.id!==h['businessos-tenant-id']||
    meta.eventId!==h['businessos-event-id']||
    meta.correlationId!==h['businessos-correlation-id']||
    meta.causationId!==h['businessos-causation-id']||
    meta.orderingKey!==event.paymentId||
    meta.correlationId!==event.paymentId||
    meta.causationId!==meta.source.aggregateId||
    keyText!==meta.tenantId.id+'|'+event.paymentId||
    typeof meta.occurredAt!=='string'||
    Number.isNaN(Date.parse(meta.occurredAt))||
    !meta.idempotencyKey)
  return {state:'CANONICAL_METADATA_MISMATCH_HOLD'};
 if(type!=='PaymentCaptured')
  return {state:'NON_CAPTURE_EVENT_HOLD',eventType:type};
 // Canonical PaymentCaptured event id is deterministic by PaymentAttempt.
 if(meta.eventId!=='payment-engine:'+meta.source.aggregateId+':PaymentCaptured')
  return {state:'CANONICAL_METADATA_MISMATCH_HOLD'};
 const cents=centsExact(event.amount?.amountDecimal,event.amount?.currency?.code);
 if(cents===null)return {state:'INVALID_MONEY_HOLD'};
 if(!ID.test(meta.tenantId.id)||!ID.test(event.paymentId)||
    !ID.test(meta.source.aggregateId)||typeof meta.eventId!=='string'||
    meta.eventId.length>128)
  return {state:'CANONICAL_METADATA_MISMATCH_HOLD'};
 return Object.freeze({
  state:'CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY',
  eventId:meta.eventId,tenantId:meta.tenantId.id,
  paymentIntentId:event.paymentId,
  paymentAttemptId:meta.source.aggregateId,
  amountCents:cents,currency:'MXN',
  payloadDigest:crypto.createHash('sha256').update(value).digest('hex'),
  isPaid:false,canSendReceipt:false
 });
}
function createR12CanonicalWireGate({enabled=false,verifyTrustedTransport}={}){
 if(typeof verifyTrustedTransport!=='function')
  throw Error('R12_CANONICAL_TRANSPORT_GATE_REQUIRED');
 async function inspect({topic,key,headers,value}={}){
  if(enabled!==true)return {state:'DISABLED'};
  const checked=inspectWire({topic,key,headers,value});
  if(checked.state!=='CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY')
   return checked;
  // The broker principal and ACLs must be checked by a separately certified
  // trusted adapter. This callback is a test seam, NOT a built-in security proof.
  let verified=false;
  try{
   verified=await verifyTrustedTransport(Object.freeze({
    topic,tenantId:checked.tenantId,
    payloadDigest:checked.payloadDigest,
    eventId:checked.eventId
   }))===true;
  }catch(_e){}
  if(!verified)return {state:'UNVERIFIED_TRANSPORT_HOLD'};
  return checked;
 }
 return Object.freeze({inspect,isEnabled:enabled===true,
  isLiveIntegrated:false,isCaptureCertified:false,
  isEconomicDispatcher:false,isNotificationDispatcher:false});
}
module.exports={TOPIC,inspectWire,createR12CanonicalWireGate};
