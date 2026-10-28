'use strict';
// R8 opt-in SAFE MENU ONLY. No BusinessOS Payment/PSP/financial side effects.
// Delivery is at-most-one attempted send. UNKNOWN never retries automatically.
// An arbitrary user message must NEVER authorize a payment or show a receipt.
const crypto=require('node:crypto');
const {extractEvents}=require('./businessosPgSignedInbox');
const {classification}=require('./businessosPgRoutingGate');
const ID=/^[A-Za-z0-9._:-]{4,255}$/;
const KEY=/^[a-f0-9]{64}$/;
const RECIPIENT=/^\d{8,20}$/;
const PROVIDER_ID=/^wamid\.[A-Za-z0-9._:-]{4,250}$/;
const MENU_TEXT='KashBitPay: menú disponible. Inicia sesión en la microaplicación para continuar. No se ha realizado ningún pago.';
function keyFor({phoneNumberId,messageId}={}){
 if(typeof phoneNumberId!=='string'||!/^\d{8,24}$/.test(phoneNumberId)||
    typeof messageId!=='string'||!ID.test(messageId))
  throw Error('R8_ID_INVALID');
 return crypto.createHash('sha256').update('waba-menu-outbox-v1\n'+phoneNumberId+'\n'+messageId).digest('hex');
}
function safeRecipient(raw,record){
 if(crypto.createHash('sha256').update(raw).digest('hex')!==record.source_envelope_digest)
  return null;
 const facts=extractEvents(raw);
 if(!facts||!facts.some(x=>x.phone===record.phone_number_id&&
    x.id===record.message_id&&x.kind==='MESSAGE'&&
    x.digest===record.event_digest))return null;
 if(classification(raw,{phone_number_id:record.phone_number_id,
   message_id:record.message_id,event_kind:'MESSAGE',
   event_digest:record.event_digest})!=='MENU_CANDIDATE')return null;
 let body;
 try{body=JSON.parse(raw.toString('utf8'));}catch(_e){return null;}
 const matches=[];
 for(const entry of body.entry||[])
  for(const change of entry.changes||[]){
   if(change.value?.metadata?.phone_number_id!==record.phone_number_id)continue;
   for(const message of change.value.messages||[])
    if(message.id===record.message_id)matches.push(message);
  }
 if(matches.length!==1||!RECIPIENT.test(matches[0].from||''))return null;
 return matches[0].from;
}
function createPgSafeMenuOutbox({pool,encryptionKey,enabled=false,send}={}){
 if(!pool||typeof pool.connect!=='function'||!Buffer.isBuffer(encryptionKey)||
    encryptionKey.length!==32||typeof send!=='function')
  throw Error('R8_OUTBOX_CONFIG');
 async function transaction(work){
  let c;
  try{c=await pool.connect();}catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT'};}
  let active=false;
  try{
   await c.query('BEGIN');active=true;
   const result=await work(c);
   await c.query('COMMIT');active=false;
   return result;
  }catch(_e){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   return {state:'DB_UNAVAILABLE_NO_EFFECT'};
  }finally{c.release();}
 }
 async function stage({phoneNumberId,messageId}={}){
  let outboxKey;
  try{outboxKey=keyFor({phoneNumberId,messageId});}
  catch(_e){return {state:'INVALID'};}
  return transaction(async c=>{
   const selected=await c.query(
    'SELECT r.phone_number_id,r.message_id,r.event_kind,r.event_digest,'+
    'r.source_envelope_digest FROM waba_channel.routing_decisions r '+
    'JOIN waba_channel.signed_envelopes e ON e.envelope_digest=r.source_envelope_digest '+
    'WHERE r.phone_number_id=$1 AND r.message_id=$2 AND r.event_kind=$3 '+
    'AND r.route_code=$4 AND e.normalized_at IS NOT NULL AND e.quarantined_at IS NULL '+
    'FOR UPDATE OF r',
    [phoneNumberId,messageId,'MESSAGE','MENU_CANDIDATE']);
   if(selected.rowCount!==1)return {state:'NOT_ELIGIBLE'};
   const row=selected.rows[0];
   const inserted=await c.query(
    'INSERT INTO waba_channel.safe_menu_outbox '+
    '(outbox_key,phone_number_id,message_id,event_kind,source_envelope_digest,event_digest) '+
    'VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (outbox_key) DO NOTHING RETURNING outbox_key',
    [outboxKey,row.phone_number_id,row.message_id,row.event_kind,
     row.source_envelope_digest,row.event_digest]);
   return inserted.rowCount===1?{state:'STAGED',outboxKey}:
    {state:'ALREADY_STAGED',outboxKey};
  });
 }
 async function reserve({outboxKey}={}){
  if(!KEY.test(outboxKey||''))return {state:'INVALID'};
  if(enabled!==true)return {state:'DISABLED'};
  return transaction(async c=>{
   const selected=await c.query(
    'SELECT o.outbox_key,o.state,o.phone_number_id,o.message_id,o.event_digest,'+
    'o.source_envelope_digest,e.nonce,e.tag,e.ciphertext '+
    'FROM waba_channel.safe_menu_outbox o '+
    'JOIN waba_channel.routing_decisions r ON r.phone_number_id=o.phone_number_id '+
    'AND r.message_id=o.message_id AND r.event_kind=o.event_kind '+
    'JOIN waba_channel.signed_envelopes e ON e.envelope_digest=o.source_envelope_digest '+
    'WHERE o.outbox_key=$1 AND r.route_code=$2 AND o.state=$3 '+
    'AND e.normalized_at IS NOT NULL AND e.quarantined_at IS NULL '+
    'FOR UPDATE OF o SKIP LOCKED',
    [outboxKey,'MENU_CANDIDATE','READY']);
   if(selected.rowCount!==1)return {state:'HOLD_OR_NOT_READY'};
   const row=selected.rows[0];
   let recipient;
   try{
    const d=crypto.createDecipheriv('aes-256-gcm',encryptionKey,row.nonce);
    d.setAuthTag(row.tag);
    const raw=Buffer.concat([d.update(row.ciphertext),d.final()]);
    recipient=safeRecipient(raw,row);
   }catch(_e){recipient=null;}
   if(!recipient)return {state:'UNVERIFIED_NO_EFFECT'};
   const changed=await c.query(
    'UPDATE waba_channel.safe_menu_outbox SET state=$2,reserved_at=clock_timestamp() '+
    'WHERE outbox_key=$1 AND state=$3 RETURNING outbox_key',
    [outboxKey,'UNKNOWN_HOLD','READY']);
   if(changed.rowCount!==1)return {state:'HOLD_OR_NOT_READY'};
   // This result is only released AFTER COMMIT; no send inside transaction.
   return {state:'RESERVED',outboxKey,recipient};
  });
 }
 async function dispatchOnce({outboxKey}={}){
  if(enabled!==true)return {state:'DISABLED'};
  const reserved=await reserve({outboxKey});
  if(reserved.state!=='RESERVED')return reserved;
  // At-most-once safety: after COMMIT of UNKNOWN_HOLD, no other caller can
  // send automatically, including if this process crashes right here.
  let acknowledgement;
  try{
   acknowledgement=await send(Object.freeze({
    to:reserved.recipient,text:MENU_TEXT,
    correlationId:reserved.outboxKey,kind:'SAFE_MENU_ONLY'
   }));
  }catch(_e){return {state:'UNKNOWN_HOLD_NO_RETRY'};}
  if(!acknowledgement||acknowledgement.accepted!==true||
     !PROVIDER_ID.test(acknowledgement.messageId||''))
   return {state:'UNKNOWN_HOLD_NO_RETRY'};
  const marked=await transaction(async c=>{
   const update=await c.query(
    'UPDATE waba_channel.safe_menu_outbox SET state=$2,'+
    'provider_message_id=$3,accepted_at=clock_timestamp() '+
    'WHERE outbox_key=$1 AND state=$4 RETURNING outbox_key',
    [outboxKey,'PROVIDER_ACCEPTED',acknowledgement.messageId,'UNKNOWN_HOLD']);
   return {state:update.rowCount===1?'PROVIDER_ACCEPTED_NOT_DELIVERED':'UNKNOWN_HOLD_NO_RETRY'};
  });
  return marked.state==='PROVIDER_ACCEPTED_NOT_DELIVERED'?marked:
   {state:'UNKNOWN_HOLD_NO_RETRY'};
 }
 return Object.freeze({stage,reserve,dispatchOnce,isEnabled:enabled===true,
  isFinancialDispatcher:false});
}
module.exports={MENU_TEXT,keyFor,safeRecipient,createPgSafeMenuOutbox};
