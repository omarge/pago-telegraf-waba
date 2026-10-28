'use strict';
// BusinessOS R4: PostgreSQL channel persistence, NOT a PSP/BusinessOS adapter.
// No live route or startup activation. Caller must provide an isolated pool.
// Only trusted server components may bind owners or reserve authorizations.
const crypto=require('node:crypto');
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const META_ID=/^[A-Za-z0-9._:-]{4,255}$/;
const DIGEST=/^[a-f0-9]{64}$/;
function validId(x){return typeof x==='string'&&ID.test(x);}
function validMoney(x){return Number.isSafeInteger(x)&&x>0;}
function createPostgresChannelStore({pool}={}){
 if(!pool||typeof pool.connect!=='function')throw Error('R4_POOL_REQUIRED');
 async function transact(fn){
  const conn=await pool.connect();
  let started=false;
  try{
   await conn.query('BEGIN');started=true;
   const result=await fn(conn);
   await conn.query('COMMIT');started=false;
   return result;
  }catch(_e){
   if(started)try{await conn.query('ROLLBACK');}catch(_ignored){}
   throw Error('R4_STORE_UNAVAILABLE');
  }finally{conn.release();}
 }
 async function createRequest({requestId,requesterId,amountCents}={}){
  if(!ORDER.test(requestId||'')||!validId(requesterId)||!validMoney(amountCents))
   return {state:'INVALID'};
  return transact(async client=>{
   const result=await client.query(
    'INSERT INTO waba_channel.requests(request_id,requester_wa_id,amount_cents) '+
    'VALUES($1,$2,$3) ON CONFLICT (request_id) DO NOTHING RETURNING request_id',
    [requestId,requesterId,amountCents]);
   if(result.rowCount===1)return {state:'CREATED'};
   const prior=await client.query(
    'SELECT requester_wa_id,amount_cents FROM waba_channel.requests WHERE request_id=$1 FOR UPDATE',
    [requestId]);
   if(prior.rowCount!==1)return {state:'CONFLICT'};
   return {state:prior.rows[0].requester_wa_id===requesterId&&
    Number(prior.rows[0].amount_cents)===amountCents?'DUPLICATE':'CONFLICT'};
  });
 }
 async function bindPayer({requestId,payerAccountId,amountCents,requesterId}={}){
  if(!ORDER.test(requestId||'')||!validId(payerAccountId)||
     !validMoney(amountCents)||!validId(requesterId))return {state:'INVALID'};
  return transact(async client=>{
   const r=await client.query(
    'SELECT * FROM waba_channel.requests WHERE request_id=$1 FOR UPDATE',
    [requestId]);
   if(r.rowCount!==1)return {state:'NOT_FOUND'};
   const v=r.rows[0];
   if(v.state!=='PENDING'||Number(v.amount_cents)!==amountCents||
      v.requester_wa_id!==requesterId)return {state:'CONFLICT'};
   if(v.payer_account_id)return {state:v.payer_account_id===payerAccountId?
    'ALREADY_BOUND':'CONFLICT'};
   await client.query('UPDATE waba_channel.requests SET payer_account_id=$2,'+
    'updated_at=clock_timestamp() WHERE request_id=$1',
    [requestId,payerAccountId]);
   return {state:'BOUND'};
  });
 }
 async function getRequest(requestId){
  if(!ORDER.test(requestId||''))return null;
  const r=await pool.query('SELECT request_id,requester_wa_id,amount_cents,'+
   'state,payer_account_id FROM waba_channel.requests WHERE request_id=$1',
   [requestId]);
  if(r.rowCount!==1)return null;
  const v=r.rows[0],cents=Number(v.amount_cents);
  if(!Number.isSafeInteger(cents))throw Error('R4_AMOUNT_OUT_OF_RANGE');
  return Object.freeze({id:v.request_id,requesterId:v.requester_wa_id,
   amount:cents,state:v.state,payerAccountId:v.payer_account_id});
 }
 async function admitSignedEvent({phoneNumberId,messageId,kind,eventDigest,
  signatureVerified=false}={}){
  // No unverified internet input is admitted; ingress F09 must authenticate
  // the ORIGINAL bytes, not a parsed/re-serialized JSON object.
  if(signatureVerified!==true)return {state:'UNVERIFIED'};
  if(!validId(phoneNumberId)||!META_ID.test(messageId||'')||
     !['MESSAGE','STATUS_SENT','STATUS_DELIVERED','STATUS_READ','STATUS_FAILED'].includes(kind)||
     !DIGEST.test(eventDigest||''))return {state:'INVALID'};
  return transact(async client=>{
   const inserted=await client.query(
    'INSERT INTO waba_channel.inbox(phone_number_id,message_id,event_kind,event_digest) '+
    'VALUES($1,$2,$3,$4) ON CONFLICT (phone_number_id,message_id,event_kind) '+
    'DO NOTHING RETURNING message_id',
    [phoneNumberId,messageId,kind,eventDigest]);
   if(inserted.rowCount===1)return {state:'ACCEPTED'};
   const stored=await client.query(
    'SELECT event_digest FROM waba_channel.inbox '+
    'WHERE phone_number_id=$1 AND message_id=$2 AND event_kind=$3',
    [phoneNumberId,messageId,kind]);
   return {state:stored.rowCount===1&&
    stored.rows[0].event_digest===eventDigest?'DUPLICATE':'CONFLICT'};
  });
 }
 async function reserveAuthorization({requestId,payerAccountId,idempotencyKey}={}){
  if(!ORDER.test(requestId||'')||!validId(payerAccountId)||
     typeof idempotencyKey!=='string'||idempotencyKey.length>128||
     !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey))
   return {state:'INVALID'};
  return transact(async client=>{
   const row=await client.query(
    'SELECT state,payer_account_id FROM waba_channel.requests '+
    'WHERE request_id=$1 FOR UPDATE',[requestId]);
   if(row.rowCount!==1)return {state:'NOT_FOUND'};
   if(row.rows[0].payer_account_id!==payerAccountId)return {state:'NOT_FOUND'};
   if(row.rows[0].state!=='PENDING')return {state:'NOT_PENDING'};
   const inserted=await client.query(
    'INSERT INTO waba_channel.authorization_reservations '+
    '(request_id,payer_account_id,idempotency_key) VALUES($1,$2,$3) '+
    'ON CONFLICT (request_id) DO NOTHING RETURNING request_id',
    [requestId,payerAccountId,idempotencyKey]);
   if(inserted.rowCount===1)return {state:'RESERVED_NO_AUTO_RETRY'};
   return {state:'HOLD_NO_AUTO_RETRY'};
  });
 }
 return Object.freeze({createRequest,bindPayer,getRequest,admitSignedEvent,
  reserveAuthorization,isDurableChannelStore:true,isLiveIntegrated:false});
}
function digestEvent(fields){
 return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
module.exports={createPostgresChannelStore,digestEvent};
