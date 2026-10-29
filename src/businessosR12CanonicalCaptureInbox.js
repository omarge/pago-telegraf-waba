'use strict';
// R12: retain a canonical capture CANDIDATE, never mark payment complete.
// Requires a trusted injected wire gate; no Kafka subscriber, no HTTP router,
// no live source/financial transport, no notification or PAID state.
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function createR12CanonicalCaptureInbox({enabled=false,pool,wireGate}={}){
 if(!pool||typeof pool.connect!=='function'||!wireGate||
    typeof wireGate.inspect!=='function')
  throw Error('R12_CANONICAL_INBOX_PORTS_REQUIRED');
 async function persistCandidate({requestId,accountId,record}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(typeof requestId!=='string'||!ORDER.test(requestId)||
     typeof accountId!=='string'||!ID.test(accountId)||
     !record||typeof record!=='object')
   return {state:'INVALID'};
  let candidate;
  try{candidate=await wireGate.inspect(record);}
  catch(_e){return {state:'UNVERIFIED_TRANSPORT_HOLD'};}
  if(candidate?.state!=='CANONICAL_CAPTURE_CANDIDATE_OFFLINE_ONLY')
   return {state:'NO_CANONICAL_CAPTURE_HOLD'};
  // Only the validated canonical decoder may produce this structure.
  if(!candidate.payloadDigest||!/^[a-f0-9]{64}$/.test(candidate.payloadDigest)||
     !candidate.eventId||candidate.eventId.length>128||
     !ID.test(candidate.tenantId||'')||
     !ID.test(candidate.paymentIntentId||'')||
     !ID.test(candidate.paymentAttemptId||'')||
     !Number.isSafeInteger(candidate.amountCents)||
     candidate.amountCents<=0||candidate.currency!=='MXN'||
     candidate.isPaid!==false||candidate.canSendReceipt!==false)
   return {state:'NO_CANONICAL_CAPTURE_HOLD'};
  let c,active=false;
  try{
   c=await pool.connect();
   await c.query('BEGIN');active=true;
   const rows=await c.query(
    'SELECT h.request_id,h.tenant_id,h.payer_account_id,h.businessos_intent_id,'+
    'h.businessos_attempt_id,h.reserved_businessos_intent_id,'+
    'h.reserved_businessos_attempt_id,h.amount_cents,h.currency,h.outcome,'+
    'r.state AS request_state,r.amount_cents AS request_amount_cents,'+
    'r.currency AS request_currency,r.payer_account_id AS request_payer '+
    'FROM waba_channel.payment_authorization_handoffs h '+
    'JOIN waba_channel.requests r ON r.request_id=h.request_id '+
    'WHERE h.request_id=$1 FOR UPDATE OF h,r',
    [requestId]);
   if(rows.rowCount!==1){await c.query('COMMIT');active=false;return {state:'NOT_ELIGIBLE_HOLD'};}
   const h=rows.rows[0];
   if(h.payer_account_id!==accountId||h.request_payer!==accountId||
      h.request_state!=='PENDING'||h.outcome!=='AUTHORIZED_PENDING_CAPTURE'||
      h.tenant_id!==candidate.tenantId||
      h.businessos_intent_id!==candidate.paymentIntentId||
      h.businessos_attempt_id!==candidate.paymentAttemptId||
      h.currency!=='MXN'||h.request_currency!=='MXN'||
      Number(h.amount_cents)!==candidate.amountCents||
      Number(h.request_amount_cents)!==candidate.amountCents){
    await c.query('COMMIT');active=false;
    return {state:'IDENTITY_OR_AMOUNT_MISMATCH_HOLD'};
   }
   // This inbox is a separate entry point: recheck R20's original
   // pre-POST reservation under the handoff row lock, not just the later
   // Kafka lookup. Legacy BOTH-NULL rows remain candidate-only.
   const legacy=h.reserved_businessos_intent_id===null&&
    h.reserved_businessos_attempt_id===null;
   if(!legacy&&(h.reserved_businessos_intent_id!==candidate.paymentIntentId||
      h.reserved_businessos_attempt_id!==candidate.paymentAttemptId)){
    await c.query('COMMIT');active=false;
    return {state:'RESERVED_ECONOMIC_IDENTITY_MISMATCH_HOLD'};
   }
   // A direct candidate inbox invocation must not bypass R20's
   // intent-wide handoff ambiguity check. It is not a financial operation.
   const bindings=await c.query(
    'SELECT request_id FROM waba_channel.payment_authorization_handoffs '+
    'WHERE tenant_id=$1 AND businessos_intent_id=$2 '+
    "AND outcome='AUTHORIZED_PENDING_CAPTURE' LIMIT 2",
    [candidate.tenantId,candidate.paymentIntentId]);
   if(bindings.rowCount!==1||bindings.rows[0].request_id!==requestId){
    await c.query('COMMIT');active=false;
    return {state:'AMBIGUOUS_PAYMENT_INTENT_BINDING_HOLD'};
   }
   const insert=await c.query(
    'INSERT INTO waba_channel.canonical_capture_candidates '+
    '(event_id,payload_sha256,request_id,tenant_id,payment_intent_id,'+
    'payment_attempt_id,amount_cents,currency) '+
    'VALUES($1,$2,$3,$4,$5,$6,$7,$8) '+
    'ON CONFLICT DO NOTHING RETURNING event_id',
    [candidate.eventId,candidate.payloadDigest,requestId,
     candidate.tenantId,candidate.paymentIntentId,candidate.paymentAttemptId,
     candidate.amountCents,'MXN']);
   let outcome='STORED_CAPTURE_CANDIDATE_NO_PAID';
   if(insert.rowCount!==1){
    const previous=await c.query(
     'SELECT event_id,payload_sha256,request_id,tenant_id,payment_intent_id,'+
     'payment_attempt_id,amount_cents,currency FROM waba_channel.canonical_capture_candidates '+
     'WHERE event_id=$1',[candidate.eventId]);
    if(previous.rowCount!==1){
     outcome='CANDIDATE_ID_COLLISION_HOLD';
    }else{
     const v=previous.rows[0];
     outcome=v.payload_sha256===candidate.payloadDigest&&
       v.request_id===requestId&&v.tenant_id===candidate.tenantId&&
       v.payment_intent_id===candidate.paymentIntentId&&
       v.payment_attempt_id===candidate.paymentAttemptId&&
       Number(v.amount_cents)===candidate.amountCents&&v.currency==='MXN'?
       'DUPLICATE_CANDIDATE_NO_PAID':'CANDIDATE_ID_COLLISION_HOLD';
    }
   }
   await c.query('COMMIT');active=false;
   return Object.freeze({state:outcome,isPaid:false,
    canSendReceipt:false,canSendWhatsApp:false});
  }catch(_e){
   if(active)try{await c.query('ROLLBACK');}catch(_e2){}
   return {state:'DB_UNAVAILABLE_NO_EFFECT'};
  }finally{if(c)c.release();}
 }
 return Object.freeze({persistCandidate,isEnabled:enabled===true,
  isProductionReady:false,isCaptureCertified:false,
  hasEconomicEffects:false,hasNotificationEffects:false});
}
module.exports={createR12CanonicalCaptureInbox};
