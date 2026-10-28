'use strict';
// R5 channel-only atomic payer-claim/request transitions. No remote actions.
// The issuer is a trusted server component; NEVER publish issue() in HTTP.
const crypto=require('node:crypto');
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function createPgPayerClaims({pool}={}){
 if(!pool||typeof pool.connect!=='function')throw Error('R5_POOL_REQUIRED');
 async function transaction(fn){
  const c=await pool.connect();
  let active=false;
  try{
   await c.query('BEGIN');active=true;
   const result=await fn(c);
   await c.query('COMMIT');active=false;
   return result;
  }catch(_error){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   throw Error('R5_PERSIST_UNAVAILABLE');
  }finally{c.release();}
 }
 async function issue({requestId}={}){
  if(!ORDER.test(requestId||''))return {state:'INVALID'};
  return transaction(async c=>{
   const rr=await c.query('SELECT request_id,state,payer_account_id FROM waba_channel.requests '+
    'WHERE request_id=$1 FOR UPDATE',[requestId]);
   if(rr.rowCount!==1)return {state:'NOT_FOUND'};
   if(rr.rows[0].payer_account_id)return {state:'ALREADY_CLAIMED'};
   if(rr.rows[0].state!=='PENDING')return {state:'NOT_PENDING'};
   const prior=await c.query('SELECT expires_at,claimed_at FROM waba_channel.payer_claims '+
    'WHERE request_id=$1 FOR UPDATE',[requestId]);
   if(prior.rowCount===1){
    if(prior.rows[0].claimed_at)return {state:'ALREADY_CLAIMED'};
    if(new Date(prior.rows[0].expires_at).getTime()>Date.now())
     return {state:'ALREADY_ISSUED'};
   }
   const claimSecret=crypto.randomBytes(32).toString('base64url');
   await c.query('INSERT INTO waba_channel.payer_claims(request_id,challenge_hash,expires_at) '+
    "VALUES($1,$2,clock_timestamp()+interval '15 minutes') "+
    'ON CONFLICT (request_id) DO UPDATE SET challenge_hash=EXCLUDED.challenge_hash,'+
    'expires_at=EXCLUDED.expires_at,claimed_at=NULL',
    [requestId,hash(claimSecret)]);
   const ex=await c.query('SELECT expires_at FROM waba_channel.payer_claims WHERE request_id=$1',
    [requestId]);
   return {state:'ISSUED',claimSecret,expiresAt:ex.rows[0].expires_at};
  });
 }
 async function claim({requestId,claimSecret,accountId,csrfVerified=false,
  whatsappLinked=false}={}){
  if(csrfVerified!==true||whatsappLinked!==true||
     !ORDER.test(requestId||'')||!ACCOUNT.test(accountId||'')||
     typeof claimSecret!=='string'||claimSecret.length<30||claimSecret.length>128)
   return {state:'DENIED'};
  const secretDigest=hash(claimSecret);
  return transaction(async c=>{
   // Consistent lock order: requests BEFORE payer_claims. Serializes claim,
   // request state changes and authorization reservations across workers.
   const r=await c.query('SELECT state,payer_account_id FROM waba_channel.requests '+
    'WHERE request_id=$1 FOR UPDATE',[requestId]);
   if(r.rowCount!==1)return {state:'NOT_FOUND'};
   if(r.rows[0].payer_account_id)return {state:'ALREADY_CLAIMED'};
   if(r.rows[0].state!=='PENDING')return {state:'NOT_PENDING'};
   const claims=await c.query('SELECT challenge_hash,expires_at,claimed_at '+
    'FROM waba_channel.payer_claims WHERE request_id=$1 FOR UPDATE',[requestId]);
   if(claims.rowCount!==1)return {state:'NOT_FOUND'};
   const rec=claims.rows[0];
   if(rec.claimed_at)return {state:'ALREADY_CLAIMED'};
   if(new Date(rec.expires_at).getTime()<=Date.now())return {state:'EXPIRED'};
   const expected=Buffer.from(rec.challenge_hash,'hex');
   const supplied=Buffer.from(secretDigest,'hex');
   if(!crypto.timingSafeEqual(expected,supplied))return {state:'DENIED'};
   await c.query('UPDATE waba_channel.requests SET payer_account_id=$2,'+
    'updated_at=clock_timestamp() WHERE request_id=$1',[requestId,accountId]);
   await c.query('UPDATE waba_channel.payer_claims SET claimed_at=clock_timestamp(),'+
    'challenge_hash=$2 WHERE request_id=$1',[requestId,hash('used:'+secretDigest)]);
   return {state:'CLAIMED'};
  });
 }
 return Object.freeze({issue,claim,isDurableClaimAndRequest:true,isLiveIntegrated:false});
}
module.exports={createPgPayerClaims};
