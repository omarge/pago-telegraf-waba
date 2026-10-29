'use strict';
const crypto=require('node:crypto');
const tokenPattern=/^[A-Za-z0-9_-]{32}$/;
const digest=token=>crypto.createHash('sha256').update(token,'utf8').digest('hex');
const newRequestId=()=> 'KPR-'+crypto.randomBytes(16).toString('hex').toUpperCase();
function createPgInvitations({pool,ttlSeconds=900,clock=()=>new Date()}={}){
 if(!pool||typeof pool.connect!=='function'||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>86400)
  throw Error('R35_INVITATION_CONFIG_INVALID');
 async function issue({requesterId,amountCents}={}){
  if(typeof requesterId!=='string'||!requesterId.trim()||
     !Number.isSafeInteger(amountCents)||amountCents<=0) return {state:'INVALID'};
  const token=crypto.randomBytes(24).toString('base64url');
  try{
   await pool.query('INSERT INTO waba_channel.invitation_claims '+ 
    '(token_sha256,requester_id,amount_cents,expires_at) VALUES($1,$2,$3,$4)',
    [digest(token),requesterId,amountCents,new Date(clock().getTime()+ttlSeconds*1000)]);
   return {state:'ISSUED',token};
  }catch(_e){return {state:'DB_UNAVAILABLE_HOLD'};}
 }
 async function claim({token,payerId='waba-payer'}={}){
  if(typeof token!=='string'||!tokenPattern.test(token)||
    typeof payerId!=='string'||!payerId.trim())return {state:'INVALID'};
  let c,active=false;
  try{
   c=await pool.connect();await c.query('BEGIN');active=true;
   const r=await c.query('SELECT requester_id,amount_cents FROM waba_channel.invitation_claims '+
    'WHERE token_sha256=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',
    [digest(token)]);
   if(r.rowCount!==1){await c.query('ROLLBACK');active=false;return {state:'NOT_ELIGIBLE_HOLD'};}
   const inv=r.rows[0],amount=Number(inv.amount_cents),requestId=newRequestId();
   if(!Number.isSafeInteger(amount)||amount<=0){await c.query('ROLLBACK');active=false;return {state:'INVALID_HOLD'};}
   await c.query('INSERT INTO waba_channel.requests '+ 
    '(request_id,requester_wa_id,amount_cents,payer_account_id) VALUES($1,$2,$3,$4)',
    [requestId,inv.requester_id,amount,payerId]);
   const changed=await c.query('UPDATE waba_channel.invitation_claims SET consumed_at=clock_timestamp(),request_id=$2 '+
    'WHERE token_sha256=$1 AND consumed_at IS NULL RETURNING token_sha256',[digest(token),requestId]);
   if(changed.rowCount!==1)throw Error('INVITATION_LOST_EXCLUSIVITY');
   await c.query('COMMIT');active=false;
   return {state:'CLAIMED',requestId,requesterId:inv.requester_id,amountCents:amount};
  }catch(_e){if(active)try{await c.query('ROLLBACK');}catch(_ignored){}return {state:'DB_UNAVAILABLE_HOLD'};}
  finally{if(c)c.release();}
 }
 return Object.freeze({issue,claim,isFinancialAuthority:false});
}
module.exports={createPgInvitations};
