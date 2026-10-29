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
 // One past the record offset is committed; it must also fit signed int64.
 return n<MAX_OFFSET?n:null;
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
   // The event id is a business-fact identity, NOT a Kafka delivery identity.
   // Kafka may legitimately redeliver the SAME fact at a DIFFERENT offset.
   // Serialize same event_id across partitions to reject collisions.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [candidate.eventId]);
   const values=[candidate.eventId,candidate.payloadDigest,
    coordinate.topic,coordinate.partition,coordinate.offset,eventType,
    candidate.tenantId,candidate.paymentIntentId,candidate.paymentAttemptId,disposition];
   // Event IDs are business facts; one fact may appear at many offsets.
   // LIMIT 1 can overlook a conflicting replay if another row matches.
   // The advisory transaction lock serializes writers for this event ID.
   // Check every persisted row within a hard bound; excess replays HOLD
   // rather than being accepted on a truncated evidence view.
   const prior=await c.query(
    'SELECT payload_sha256,event_type,tenant_id,payment_intent_id,'+
    'payment_attempt_id,disposition FROM waba_channel.canonical_kafka_ingress '+
    'WHERE event_id=$1 LIMIT 4097 FOR UPDATE',[candidate.eventId]);
   // Exceeding the audit bound itself is a hard HOLD. An unlimited number of
   // legitimate redeliveries must not exhaust PostgreSQL/Node resources.
   if(prior.rowCount>4096||prior.rows.some(v=>
       v.payload_sha256!==candidate.payloadDigest||
       v.event_type!==eventType||v.tenant_id!==candidate.tenantId||
       v.payment_intent_id!==candidate.paymentIntentId||
       v.payment_attempt_id!==candidate.paymentAttemptId||
       v.disposition!==disposition)){
    await c.query('ROLLBACK');active=false;
    return {state:'EVENT_ID_OR_OFFSET_COLLISION_HOLD'};
   }
   const saved=await c.query(
    'INSERT INTO waba_channel.canonical_kafka_ingress '+
    '(event_id,payload_sha256,topic,partition_id,record_offset,event_type,'+
    'tenant_id,payment_intent_id,payment_attempt_id,disposition) '+
    'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) '+
    'ON CONFLICT (topic,partition_id,record_offset) DO NOTHING RETURNING event_id',
    values);
   if(saved.rowCount!==1){
    const previous=await c.query(
     'SELECT * FROM waba_channel.canonical_kafka_ingress '+
     'WHERE topic=$1 AND partition_id=$2 AND record_offset=$3 FOR UPDATE',
     [coordinate.topic,coordinate.partition,coordinate.offset]);
    const v=previous.rows[0];
    if(previous.rowCount!==1||!v||v.event_id!==candidate.eventId||
       v.payload_sha256!==candidate.payloadDigest||v.event_type!==eventType||
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
     // The economic intent is the one-to-one boundary. Filtering by
     // attempt before checking ambiguity could hide an authorization for
     // ANOTHER attempt of the SAME tenant + intent.
     'SELECT request_id,payer_account_id,businessos_attempt_id,'+
     'reserved_businessos_intent_id,reserved_businessos_attempt_id '+
     'FROM waba_channel.payment_authorization_handoffs '+
     'WHERE tenant_id=$1 AND businessos_intent_id=$2 '+
     'AND outcome=$3 LIMIT 2',
     [candidate.tenantId,candidate.paymentIntentId,
      'AUTHORIZED_PENDING_CAPTURE']);
   }catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT',mayCommit:false};}
   if(lookup.rowCount!==1||
      lookup.rows[0].businessos_attempt_id!==candidate.paymentAttemptId)
    return {state:'UNBOUND_OR_AMBIGUOUS_CAPTURE_HOLD',mayCommit:false};
   // R20 pre-POST reservation is a separate immutable economic identity.
   // Legacy handoffs with BOTH reserved IDs NULL remain candidates-only,
   // never positive finality. A partial or contradictory reservation HOLDs
   // before any candidate write or Kafka offset confirmation.
   const bound=lookup.rows[0];
   const legacy=bound.reserved_businessos_intent_id===null&&
    bound.reserved_businessos_attempt_id===null;
   if(!legacy&&(bound.reserved_businessos_intent_id!==candidate.paymentIntentId||
      bound.reserved_businessos_attempt_id!==candidate.paymentAttemptId))
    return {state:'RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD',mayCommit:false};
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
