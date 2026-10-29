'use strict';
// R12 OFFLINE PRE-FLIGHT: this is NOT a Payment Engine capture API.
// The injected reader is a FUTURE trusted source adapter; its return shape is
// WABA-local normalization, NOT a claim about any existing upstream REST DTO.
// No PAID/receipt, no state write, no event, no provider network transport.
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUCCESS=new Set(['CAPTURED','SUCCEEDED']);
const PROVIDER_SUCCESS=new Set(['CAPTURED','SUCCEEDED']);
function validId(s){return typeof s==='string'&&ID.test(s);}
function amount(v){
 if(typeof v==='bigint')return v>0n&&v<=BigInt(Number.MAX_SAFE_INTEGER)?Number(v):null;
 if(typeof v==='number')return Number.isSafeInteger(v)&&v>0?v:null;
 // PostgreSQL int8 is decoded as decimal string.
 if(typeof v==='string'&&/^[1-9][0-9]*$/.test(v)){
  const n=Number(v);return Number.isSafeInteger(n)?n:null;
 }
 return null;
}
function snapshot(h,r,requestId,accountId){
 if(!h||!r||h.request_id!==requestId||r.request_id!==requestId||
    h.payer_account_id!==accountId||r.payer_account_id!==accountId||
    h.outcome!=='AUTHORIZED_PENDING_CAPTURE'||r.state!=='PENDING'||
    !validId(h.tenant_id)||!validId(h.businessos_intent_id)||
    !validId(h.businessos_attempt_id)||
    h.currency!=='MXN'||r.currency!=='MXN'||
    amount(h.amount_cents)===null||
    amount(h.amount_cents)!==amount(r.amount_cents)||
    typeof h.idempotency_key!=='string'||!h.idempotency_key||
    !h.finalized_at||!h.reserved_at)return null;
 return Object.freeze({
  requestId,accountId,tenantId:h.tenant_id,
  intentId:h.businessos_intent_id,attemptId:h.businessos_attempt_id,
  amountCents:amount(h.amount_cents),currency:'MXN',
  idempotencyKey:h.idempotency_key,
  outcome:h.outcome,
  finalizedAt:new Date(h.finalized_at).getTime(),
  reservedAt:new Date(h.reserved_at).getTime()
 });
}
function same(a,b){
 return a&&b&&Object.keys(a).every(k=>Object.is(a[k],b[k]));
}
function classify(observation,prior){
 if(!observation||typeof observation!=='object'||Array.isArray(observation))
  return 'UNAVAILABLE_HOLD_NO_EFFECT';
 const idMatch=observation.tenantId===prior.tenantId&&
  observation.paymentIntentId===prior.intentId&&
  observation.paymentAttemptId===prior.attemptId;
 const moneyMatch=amount(observation.amountCents)===prior.amountCents&&
  observation.currency===prior.currency;
 if(!idMatch||!moneyMatch)return 'OBSERVATION_MISMATCH_HOLD';
 if(!SUCCESS.has(observation.intentStatus)||
    !SUCCESS.has(observation.attemptStatus)||
    !PROVIDER_SUCCESS.has(observation.providerOutcomeStatus)||
    observation.reconciliationFindingType!=='MATCHED')
  return 'OBSERVATION_NOT_FINAL_HOLD';
 return 'CAPTURE_EVIDENCE_CANDIDATE_OFFLINE_ONLY';
}
function createR12CaptureObservationGate({enabled=false,pool,readAuthoritativeObservation}={}){
 if(!pool||typeof pool.query!=='function'||typeof readAuthoritativeObservation!=='function')
  throw Error('R12_TRUSTED_READ_PORTS_REQUIRED');
 async function load(requestId,accountId){
  const r=await pool.query(
   'SELECT h.*,r.request_id AS r_request_id,r.state AS r_state,'+
   'r.payer_account_id AS r_payer_account_id,'+
   'r.amount_cents AS r_amount_cents,r.currency AS r_currency '+
   'FROM waba_channel.payment_authorization_handoffs h '+
   'JOIN waba_channel.requests r ON r.request_id=h.request_id '+
   'WHERE h.request_id=$1 AND h.payer_account_id=$2 AND r.payer_account_id=$2',
   [requestId,accountId]);
  if(r.rowCount!==1)return null;
  const row=r.rows[0];
  return snapshot(row,{
   request_id:row.r_request_id,state:row.r_state,
   payer_account_id:row.r_payer_account_id,
   amount_cents:row.r_amount_cents,currency:row.r_currency
  },requestId,accountId);
 }
 async function probe({requestId,accountId}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(typeof requestId!=='string'||!ORDER.test(requestId)||
     !validId(accountId))return {state:'INVALID'};
  let prior;
  try{prior=await load(requestId,accountId);}
  catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT'};}
  if(!prior)return {state:'NOT_ELIGIBLE_NO_EFFECT'};
  let observation;
  try{
   // Only the server-injected port receives this trusted DB snapshot. It
   // cannot accept an observation, status or tenant from HTTP/browser input.
   observation=await readAuthoritativeObservation(Object.freeze({
    tenantId:prior.tenantId,
    paymentIntentId:prior.intentId,paymentAttemptId:prior.attemptId,
    amountCents:prior.amountCents,currency:prior.currency,
    requestId:prior.requestId
   }));
  }catch(_e){return {state:'OBSERVATION_UNAVAILABLE_HOLD'};}
  // Fail closed if payer/amount/tenant/handoff changed during the await.
  let after;
  try{after=await load(requestId,accountId);}
  catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT'};}
  if(!same(prior,after))return {state:'HANDOFF_CHANGED_HOLD'};
  const state=classify(observation,prior);
  return Object.freeze({state,
   // Never disclose provider reference or observations to a browser.
   isPaid:false,isCaptureCertified:false,
   canSendReceipt:false,canSendWhatsApp:false});
 }
 return Object.freeze({probe,isEnabled:enabled===true,
  isLiveIntegrated:false,isCaptureCertified:false,
  isEconomicMutation:false,isNotificationDispatcher:false});
}
module.exports={createR12CaptureObservationGate,classify};
