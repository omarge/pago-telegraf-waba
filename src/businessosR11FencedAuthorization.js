'use strict';
// R11: OFFLINE ONLY. One durable WABA authorization handoff, no automatic retry.
// The only external attempt is an injected adapter and ONLY after a PG COMMIT.
// Not mounted by the WABA runtime. Never infer PaymentCapture/PAID from AUTHORIZED.
const crypto=require('node:crypto');
const {buildAuthorizationRequest}=require('./businessosAuthorizationAdapter');
const {methodBindingDigest}=require('./businessosMethodBinding');
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9._~+\/=-]{16,4096}$/;
const isId=s=>typeof s==='string'&&ID.test(s);
function snapshot(row){
 if(!row||!ORDER.test(row.request_id||'')||row.state!=='PENDING'||
    !isId(row.payer_account_id)||!Number.isSafeInteger(Number(row.amount_cents))||
    Number(row.amount_cents)<=0||row.currency!=='MXN'||
    !(row.created_at instanceof Date)||Number.isNaN(row.created_at.getTime()))
  return null;
 return Object.freeze({
  id:row.request_id,payerAccountId:row.payer_account_id,
  requesterId:row.requester_wa_id,amount:Number(row.amount_cents),
  currency:row.currency,state:row.state,
  createdAt:row.created_at.toISOString()
 });
}
function sameRequest(row,prior){
 return row&&prior&&row.request_id===prior.id&&
  row.payer_account_id===prior.payerAccountId&&row.state==='PENDING'&&
  row.currency==='MXN'&&Number(row.amount_cents)===prior.amount&&
  row.requester_wa_id===prior.requesterId&&
  row.created_at instanceof Date&&row.created_at.toISOString()===prior.createdAt;
}
function authorizeAuthority({authority,evidence,accountId,request,device}={}){
 if(!authority||!evidence||evidence.state!=='EVIDENCE_CANDIDATE_OFFLINE_ONLY'||
    evidence.requestId!==request.id||
    evidence.tenantId!==authority.tenantId||
    evidence.customerId!==authority.customerId||
    evidence.assessmentId!==authority.fraudAssessmentId||
    !UUID.test(evidence.assessmentId||'')||
    authority.accountId!==accountId||
    authority.fraudDecision!=='APPROVE'||
    !TOKEN.test(authority.delegatedBearer||''))
  throw Error('R11_TRUSTED_EVIDENCE_MISMATCH');
 // R10 calculates this from the vault method actually assessed by Fraud.
 // R11 may not use a different CustomerVault reference, merchant or provider.
 const observedBinding=methodBindingDigest({
  requestId:request.id,accountId,
  tenantId:authority.tenantId,customerId:authority.customerId,
  merchantId:authority.merchantId,providerAccountId:authority.providerAccountId,
  amountCents:request.amount,
  provider:authority.paymentMethodReferenceProvider,
  opaqueReference:authority.paymentMethodReference,
  assessmentId:authority.fraudAssessmentId,
  deviceFingerprint:device?.fingerprint,deviceIp:device?.ip
 });
 if(evidence.paymentMethodBindingDigest!==observedBinding||
    authority.clientIpAddress!==device.ip)
  throw Error('R11_METHOD_FRAUD_BINDING_MISMATCH');
 const payment={id:request.id,amount:request.amount,
  currency:'MXN',state:'PENDING',accountId};
 const body=buildAuthorizationRequest({payment,authority});
 return {payment,body};
}
function createR11FencedAuthorization({
 enabled=false,pool,prepareEvidence,resolveAuthority,resolveDevice,adapter
}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'||
    !prepareEvidence||typeof prepareEvidence.prepare!=='function'||
    typeof resolveAuthority!=='function'||typeof resolveDevice!=='function'||
    !adapter||typeof adapter.authorize!=='function')
  throw Error('R11_DEPENDENCIES_REQUIRED');
 async function failSafeTxn(work){
  let c,active=false;
  try{
   c=await pool.connect();
   await c.query('BEGIN');active=true;
   const result=await work(c);
   await c.query('COMMIT');active=false;
   return result;
  }catch(_e){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   return {state:'DB_UNAVAILABLE_NO_EFFECT'};
  }finally{if(c)c.release();}
 }
 async function authorizeOnce({requestId,accountId,consent,csrfVerified}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(consent!==true||csrfVerified!==true)
   return {state:'CONFIRMATION_REQUIRED'};
  if(!ORDER.test(requestId||'')||!isId(accountId))
   return {state:'INVALID'};
  let record;
  try{
   const r=await pool.query('SELECT * FROM waba_channel.requests WHERE request_id=$1',
    [requestId]);
   record=r.rowCount===1?snapshot(r.rows[0]):null;
  }catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT'};}
  if(!record||record.payerAccountId!==accountId)return {state:'NOT_FOUND'};
  // Preparing evidence may use legitimate external Fraud services in a FUTURE
  // runtime: stable idempotency is handled by Fraud, never blindly retried here.
  let device,evidence,authority,preflight;
  try{
   device=await resolveDevice({requestId,accountId});
   evidence=await prepareEvidence.prepare({request:record,accountId,device});
   if(evidence?.state!=='EVIDENCE_CANDIDATE_OFFLINE_ONLY')
    return {state:'EVIDENCE_NOT_AUTHORIZED'};
   authority=Object.freeze({...await resolveAuthority({request:record,accountId,evidence})});
   preflight=authorizeAuthority({authority,evidence,accountId,request:record,device});
  }catch(_e){return {state:'TRUSTED_MAPPING_UNVERIFIED'};}
  const authorityFingerprint=crypto.createHash('sha256')
   .update(JSON.stringify({
    tenantId:authority.tenantId,customerId:authority.customerId,
    fraudAssessmentId:authority.fraudAssessmentId,
    paymentMethodReferenceProvider:authority.paymentMethodReferenceProvider,
    paymentMethodReference:authority.paymentMethodReference,
    amount:preflight.body.amount,requestId
   })).digest('hex');
  const reserved=await failSafeTxn(async c=>{
   const rr=await c.query(
    'SELECT * FROM waba_channel.requests WHERE request_id=$1 FOR UPDATE',[requestId]);
   if(rr.rowCount!==1||!sameRequest(rr.rows[0],record))
    return {state:'REQUEST_CHANGED_NO_EFFECT'};
   const inserted=await c.query(
    'INSERT INTO waba_channel.authorization_reservations '+
    '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3) '+
    'ON CONFLICT (request_id) DO NOTHING RETURNING request_id',
    [requestId,accountId,preflight.body.idempotencyKey]);
   if(inserted.rowCount!==1)return {state:'HOLD_NO_AUTO_RETRY'};
   await c.query('INSERT INTO waba_channel.payment_authorization_handoffs '+
    '(request_id,payer_account_id,tenant_id,customer_id,fraud_assessment_id,'+
    'amount_cents,idempotency_key,authority_fingerprint) '+
    'VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [requestId,accountId,authority.tenantId,authority.customerId,
     authority.fraudAssessmentId,record.amount,preflight.body.idempotencyKey,
     authorityFingerprint]);
   return {state:'RESERVED',requestId};
  });
  if(reserved.state!=='RESERVED')return reserved;
  // Financial POST can ONLY occur after durable COMMIT. If this process
  // crashes now, reservation survives and next request remains HOLD.
  let outcome;
  try{
   outcome=await adapter.authorize({
    payment:preflight.payment,authority
   });
  }catch(_e){return {state:'UNKNOWN_HOLD_NO_AUTO_RETRY'};}
  const map={
   AUTHORIZED_PENDING_CAPTURE:'AUTHORIZED_PENDING_CAPTURE',
   DECLINED:'DECLINED',PRE_EXECUTION_FAILED:'PRE_EXECUTION_FAILED',
   DENIED_BY_BUSINESSOS:'DENIED'
  };
  const terminal=map[outcome?.state];
  if(!terminal)return {state:'UNKNOWN_HOLD_NO_AUTO_RETRY'};
  // Every execution-bearing outcome must identify THIS payment, even DECLINED.
  const hasExecutionIds=outcome?.paymentIntentId!=null||
   outcome?.paymentAttemptId!=null;
  if((terminal==='AUTHORIZED_PENDING_CAPTURE'||terminal==='DECLINED'||
      hasExecutionIds)&&
     (outcome.paymentIntentId!==preflight.body.paymentIntentId||
      outcome.paymentAttemptId!==preflight.body.paymentAttemptId))
   return {state:'UNKNOWN_HOLD_NO_AUTO_RETRY'};
  const updated=await failSafeTxn(async c=>{
   const q=await c.query(
    'UPDATE waba_channel.payment_authorization_handoffs SET outcome=$2,'+
    'businessos_intent_id=$3,businessos_attempt_id=$4,finalized_at=clock_timestamp() '+
    'WHERE request_id=$1 AND outcome=$5 RETURNING request_id',
    [requestId,terminal,
     outcome.paymentIntentId||null,outcome.paymentAttemptId||null,'UNKNOWN_HOLD']);
   return {state:q.rowCount===1?'RECORDED':'HOLD_NO_AUTO_RETRY'};
  });
  return updated.state==='RECORDED'?{state:terminal==='AUTHORIZED_PENDING_CAPTURE'?
   'AUTHORIZED_PENDING_CAPTURE_NOT_PAID':terminal}:
   {state:'UNKNOWN_HOLD_NO_AUTO_RETRY'};
 }
 return Object.freeze({authorizeOnce,isEnabled:enabled===true,
  isLiveIntegrated:false,isCaptureDispatcher:false});
}
module.exports={snapshot,sameRequest,authorizeAuthority,createR11FencedAuthorization};
