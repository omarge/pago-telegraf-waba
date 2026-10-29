'use strict';
const crypto=require('node:crypto');
// R12-E: read-only economic contradiction/reversal projection on persisted
// WABA canonical evidence. NEVER an authoritative Payment read API.
// No PAID, receipt, ledger mutation, Kafka commit, PSP or Meta effects.
const REQUEST=/^KPR-[A-F0-9]{32}$/;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Limit untrusted Kafka replay history per tenant+intent in one snapshot.
const MAX_CANONICAL_EVENTS=4096;
const THREATS=new Set([
 'PaymentRefunded','PaymentExecutionUnknown','PaymentExecutionResolved',
 'PaymentFailed'
]);
const validCents=x=>{
 const s=typeof x==='bigint'?x.toString():String(x);
 if(!/^[1-9]\d*$/.test(s))return null;
 const n=Number(s);
 return Number.isSafeInteger(n)?n:null;
};
function createR12EconomicReversalHoldProjection({enabled=false,pool}={}){
 if(!pool||typeof pool.connect!=='function')
  throw Error('R12_E_READ_ONLY_POOL_REQUIRED');
 async function assess({requestId,accountId}={}){
  if(enabled!==true)return {state:'DISABLED',isPaid:false};
  if(typeof requestId!=='string'||!REQUEST.test(requestId)||
     typeof accountId!=='string'||!ACCOUNT.test(accountId))
   return {state:'INVALID',isPaid:false};
  let c,active=false;
  try{
   c=await pool.connect();
   await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   active=true;
   const a=await c.query(
    'SELECT h.request_id,h.payer_account_id,h.tenant_id,h.businessos_intent_id,'+
    'h.businessos_attempt_id,h.amount_cents,h.currency,h.outcome,'+
    'r.state AS request_state,r.payer_account_id AS request_payer,'+
    'r.amount_cents AS request_amount,r.currency AS request_currency '+
    'FROM waba_channel.payment_authorization_handoffs h '+
    'JOIN waba_channel.requests r ON r.request_id=h.request_id '+
    'WHERE h.request_id=$1 AND h.payer_account_id=$2 AND r.payer_account_id=$2',
    [requestId,accountId]);
   if(a.rowCount!==1){
    await c.query('COMMIT');active=false;
    return {state:'NOT_ELIGIBLE_HOLD',isPaid:false};
   }
   const h=a.rows[0],amount=validCents(h.amount_cents);
   if(h.outcome!=='AUTHORIZED_PENDING_CAPTURE'||
      h.request_state!=='PENDING'||h.request_payer!==accountId||
      !h.tenant_id||!h.businessos_intent_id||!h.businessos_attempt_id||
      amount===null||amount!==validCents(h.request_amount)||
      h.currency!=='MXN'||h.request_currency!=='MXN'){
    await c.query('COMMIT');active=false;
    return {state:'HANDOFF_NOT_VALID_HOLD',isPaid:false};
   }
   // One payment intent cannot be the source of two separately authorized
   // WABA requests. Kafka's ingress lookup already holds on ambiguity, but
   // the read-side snapshot must independently recheck historical bindings.
   const bindings=await c.query(
    'SELECT request_id FROM waba_channel.payment_authorization_handoffs '+
    'WHERE tenant_id=$1 AND businessos_intent_id=$2 '+
    "AND outcome='AUTHORIZED_PENDING_CAPTURE' LIMIT 2",
    [h.tenant_id,h.businessos_intent_id]);
   if(bindings.rowCount!==1||bindings.rows[0].request_id!==requestId){
    await c.query('COMMIT');active=false;
    return Object.freeze({state:'AMBIGUOUS_PAYMENT_INTENT_BINDING_HOLD',
     isPaid:false,isFinal:false,isReconciled:false,
     isProviderVerified:false,canSendReceipt:false,canSendWhatsApp:false});
   }
   // Tenant/intent scope intentionally includes ALL attempts. A refund or
   // UNKNOWN on any attempt must not be concealed by a matching capture row.
   const events=await c.query(
    'SELECT event_id,payload_sha256,event_type,payment_attempt_id,'+
    'disposition,record_offset,partition_id FROM waba_channel.canonical_kafka_ingress '+
    'WHERE tenant_id=$1 AND payment_intent_id=$2 ORDER BY created_at,event_id '+
    'LIMIT $3',
    [h.tenant_id,h.businessos_intent_id,MAX_CANONICAL_EVENTS+1]);
   if(events.rowCount>MAX_CANONICAL_EVENTS){
    await c.query('COMMIT');active=false;
    return Object.freeze({state:'CANONICAL_HISTORY_LIMIT_HOLD',
     isPaid:false,isFinal:false,isReconciled:false,
     isProviderVerified:false,canSendReceipt:false,canSendWhatsApp:false});
   }
   // An unacknowledged poison/foreign event may contain a financial fact
   // missing from the accepted inbox. Its Kafka key is already hashed by
   // the HOLD journal; compare hashes, never persist or expose the raw key.
   const kafkaKey=h.tenant_id+'|'+h.businessos_intent_id;
   const keyDigest=crypto.createHash('sha256').update(kafkaKey,'utf8').digest('hex');
   const held=await c.query(
    'SELECT 1 FROM waba_channel.canonical_kafka_holds '+
    "WHERE topic='businessos.payment.events.v1' AND key_sha256=$1 LIMIT 1",
    [keyDigest]);
   const candidates=await c.query(
    'SELECT event_id,payload_sha256,payment_attempt_id,amount_cents,currency,'+
    'tenant_id,payment_intent_id '+
    'FROM waba_channel.canonical_capture_candidates '+
    'WHERE request_id=$1',[requestId]);
   await c.query('COMMIT');active=false;
   const record=events.rows;
   const kinds=new Set(record.map(x=>x.event_type));
   // These data are still only signed/candidate financial facts. No provider
   // reconciliation/settlement evidence is materialized here.
   let state='NO_MATCHED_CAPTURE_HOLD';
   const allFenced=record.every(x=>x.event_id&&x.payload_sha256&&
    ['CAPTURE_CANDIDATE_ONLY','NON_CAPTURE_HOLD'].includes(x.disposition)&&
    (x.event_type==='PaymentCaptured'?
     x.disposition==='CAPTURE_CANDIDATE_ONLY':
     x.disposition==='NON_CAPTURE_HOLD'));
   const seen=new Map();
   let collision=false;
   for(const e of record){
    const first=seen.get(e.event_id);
    if(first&&(
      first.payload_sha256!==e.payload_sha256||
      first.event_type!==e.event_type||
      first.payment_attempt_id!==e.payment_attempt_id
    ))collision=true;
    seen.set(e.event_id,e);
   }
   // Same event_id+payload replay at different Kafka offsets is allowed,
   // but competing economic capture facts on one payment intent are NOT.
   const captured=record.filter(e=>e.event_type==='PaymentCaptured');
   const competingCapture=captured.some(e=>
    e.payment_attempt_id!==h.businessos_attempt_id)||
    new Set(captured.map(e=>e.event_id)).size>1;
   if(!allFenced||collision)state='CANONICAL_CONFLICT_HOLD';
   else if(competingCapture)state='COMPETING_CAPTURE_ATTEMPTS_HOLD';
   else if(held.rowCount>0)state='INCOMPLETE_INGRESS_HOLD';
   else if([...THREATS].some(x=>kinds.has(x)))
    state='REVERSAL_UNKNOWN_OR_FAILURE_HOLD';
   else if(candidates.rowCount!==1)
    state='CAPTURE_CANDIDATE_MISSING_OR_AMBIGUOUS_HOLD';
   else{
    const v=candidates.rows[0];
    const matches=record.filter(e=>
     e.event_id===v.event_id&&
     e.payload_sha256===v.payload_sha256&&
     e.event_type==='PaymentCaptured'&&
     e.payment_attempt_id===h.businessos_attempt_id&&
     e.disposition==='CAPTURE_CANDIDATE_ONLY');
    state=matches.length>0&&
      v.payment_attempt_id===h.businessos_attempt_id&&
      v.tenant_id===h.tenant_id&&
      v.payment_intent_id===h.businessos_intent_id&&
      validCents(v.amount_cents)===amount&&v.currency==='MXN'?
     'CAPTURE_CANDIDATE_RECONCILIATION_PENDING':
     'CAPTURE_EVIDENCE_MISMATCH_HOLD';
   }
   return Object.freeze({state,isPaid:false,isFinal:false,
    canSendReceipt:false,canSendWhatsApp:false,
    isReconciled:false,isProviderVerified:false,
    observedEvents:record.length});
  }catch(_e){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   return {state:'DB_UNAVAILABLE_HOLD',isPaid:false};
  }finally{if(c)c.release();}
 }
 return Object.freeze({assess,isEnabled:enabled===true,isMountedByWaba:false,
  isEconomicDispatcher:false,isMetaDispatcher:false,isFinalityAuthority:false});
}
module.exports={createR12EconomicReversalHoldProjection};
