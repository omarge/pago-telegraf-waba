'use strict';
// R12: one Kafka record -> durable PostgreSQL facts -> offset MAY be committed.
// NOT a financial dispatcher or proof of broker ACLs. No PAID and no Meta send.
// Unknown/foreign/malformed events fail closed without advancing offsets.
const {inspectWire,TOPIC}=require('./businessosR12CanonicalWireGate');
const POS=/^(0|[1-9][0-9]*)$/;
const MAX_OFFSET=9223372036854775807n;
const TYPES=new Set(['PaymentCaptured','PaymentAuthorized','PaymentFailed',
 'PaymentRefunded','PaymentExecutionUnknown','PaymentExecutionResolved']);
function offsetOf(s){
 if(typeof s!=='string'||!POS.test(s)||s.length>19)return null;
 const n=BigInt(s);
 return n<=MAX_OFFSET?n:null;
}
function recordCoordinate({topic,partition,offset}={}){
 const n=offsetOf(offset);
 if(topic!==TOPIC||!Number.isSafeInteger(partition)||partition<0||n===null)
  return null;
 return Object.freeze({topic,partition,offset:n.toString(),nextOffset:(n+1n).toString()});
}
function createR12KafkaCommitProcessor({enabled=false,pool,captureInbox}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'||
    !captureInbox||typeof captureInbox.persistCandidate!=='function')
  throw Error('R12_KAFKA_PROCESSOR_PORTS_REQUIRED');
 async function audit({candidate,coordinate,disposition,eventType}){
  if(!candidate||!candidate.eventId||candidate.eventId.length>128||
     !/^[a-f0-9]{64}$/.test(candidate.payloadDigest||'')||
     !TYPES.has(eventType))return {state:'UNVERIFIED_EVENT_HOLD'};
  let c,active=false;
  try{
   c=await pool.connect();
   await c.query('BEGIN');active=true;
   const values=[candidate.eventId,candidate.payloadDigest,
    coordinate.topic,coordinate.partition,coordinate.offset,eventType,
    candidate.tenantId,candidate.paymentIntentId,candidate.paymentAttemptId,disposition];
   const saved=await c.query(
    'INSERT INTO waba_channel.canonical_kafka_ingress '+
    '(event_id,payload_sha256,topic,partition_id,record_offset,event_type,'+
    'tenant_id,payment_intent_id,payment_attempt_id,disposition) '+
    'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) '+
    'ON CONFLICT DO NOTHING RETURNING event_id',values);
   if(saved.rowCount!==1){
    const existing=await c.query(
     'SELECT * FROM waba_channel.canonical_kafka_ingress '+
     'WHERE event_id=$1 OR (topic=$2 AND partition_id=$3 AND record_offset=$4) '+
     'FOR UPDATE',
     [candidate.eventId,coordinate.topic,coordinate.partition,coordinate.offset]);
    const v=existing.rows[0];
    if(existing.rowCount!==1||!v||
       v.event_id!==candidate.eventId||v.payload_sha256!==candidate.payloadDigest||
       v.topic!==coordinate.topic||v.partition_id!==coordinate.partition||
       String(v.record_offset)!==coordinate.offset||v.event_type!==eventType||
       v.tenant_id!==candidate.tenantId||
       v.payment_intent_id!==candidate.paymentIntentId||
       v.payment_attempt_id!==candidate.paymentAttemptId||
       v.disposition!==disposition){
     await c.query('ROLLBACK');active=false;
     return {state:'EVENT_ID_OR_OFFSET_COLLISION_HOLD'};
    }
   }
   await c.query('COMMIT');active=false;
   return {state:saved.rowCount===1?'AUDITED_NO_EFFECT':'REPLAY_AUDITED_NO_EFFECT'};
  }catch(_e){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   return {state:'DB_UNAVAILABLE_NO_EFFECT'};
  }finally{if(c)c.release();}
 }
 async function process({topic,partition,offset,key,headers,value}={}){
  if(enabled!==true)return {state:'DISABLED',mayCommit:false};
  const coordinate=recordCoordinate({topic,partition,offset});
  if(!coordinate)return {state:'INVALID_COORDINATE_HOLD',mayCommit:false};
  // A source record must come from the configured Kafka consumer. Wire checks
  // alone cannot cryptographically prove its broker principal or ACL.
  const wire={topic,key,headers,value};
  const candidate=inspectWire(wire);
  if(candidate.state!=='CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY'&&
     candidate.state!=='NON_CAPTURE_EVENT_HOLD')
   return {state:'UNVERIFIED_CANONICAL_HOLD',mayCommit:false};
  const eventType=candidate.state==='NON_CAPTURE_EVENT_HOLD'?
   candidate.eventType:'PaymentCaptured';
  if(eventType==='PaymentCaptured'){
   let lookup;
   try{
    lookup=await pool.query(
     'SELECT request_id,payer_account_id FROM waba_channel.payment_authorization_handoffs '+
     'WHERE tenant_id=$1 AND businessos_intent_id=$2 AND businessos_attempt_id=$3 '+
     'AND outcome=$4 LIMIT 2',
     [candidate.tenantId,candidate.paymentIntentId,candidate.paymentAttemptId,
      'AUTHORIZED_PENDING_CAPTURE']);
   }catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT',mayCommit:false};}
   if(lookup.rowCount!==1)
    return {state:'UNBOUND_OR_AMBIGUOUS_CAPTURE_HOLD',mayCommit:false};
   let saved;
   try{
    saved=await captureInbox.persistCandidate({
     requestId:lookup.rows[0].request_id,accountId:lookup.rows[0].payer_account_id,
     record:wire});
   }catch(_e){return {state:'CAPTURE_INBOX_UNAVAILABLE_HOLD',mayCommit:false};}
   if(!['STORED_CAPTURE_CANDIDATE_NO_PAID','DUPLICATE_CANDIDATE_NO_PAID']
     .includes(saved?.state))
    return {state:'CAPTURE_INBOX_REJECTED_HOLD',mayCommit:false};
  }
  const done=await audit({
   candidate,coordinate,eventType,
   disposition:eventType==='PaymentCaptured'?
    'CAPTURE_CANDIDATE_ONLY':'NON_CAPTURE_HOLD'
  });
  if(!['AUDITED_NO_EFFECT','REPLAY_AUDITED_NO_EFFECT'].includes(done.state))
   return {state:done.state,mayCommit:false};
  return Object.freeze({state:eventType==='PaymentCaptured'?
    'CAPTURE_CANDIDATE_DURABLE_NO_PAID':'NON_CAPTURE_DURABLE_HOLD',
   mayCommit:true,nextOffset:coordinate.nextOffset,financialActions:0,
   metaSends:0,isPaid:false,canSendReceipt:false});
 }
 return Object.freeze({process,isEnabled:enabled===true,
  isLiveIntegrated:false,isEconomicDispatcher:false,isMetaDispatcher:false});
}
module.exports={recordCoordinate,createR12KafkaCommitProcessor};
