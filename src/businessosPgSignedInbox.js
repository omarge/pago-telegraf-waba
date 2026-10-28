'use strict';
// R5 optional raw signed webhook ingress: HMAC before any DB or ACK.
// Stores encrypted Meta body and normalized dedupe identities atomically.
// No outbound messages, no inbox worker, no real BusinessOS events.
const crypto=require('node:crypto');
const {verifySignature}=require('./f06DeliveryEvidence');
const PHONE=/^\d{8,24}$/;
const META_ID=/^[A-Za-z0-9._:-]{4,255}$/;
const KINDS=new Set(['sent','delivered','read','failed']);
function createPgSignedInbox({pool,appSecret,encryptionKey}={}){
 if(!pool||typeof pool.connect!=='function'||
    typeof appSecret!=='string'||appSecret.length<16||
    !Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)
  throw Error('R5_INBOX_CONFIG');
 function parse(raw){
  let envelope;
  try{envelope=JSON.parse(raw.toString('utf8'));}catch(_e){return null;}
  if(envelope?.object!=='whatsapp_business_account'||!Array.isArray(envelope.entry)||
     envelope.entry.length<1||envelope.entry.length>10)return null;
  const events=[];
  for(const entry of envelope.entry){
   if(!Array.isArray(entry.changes)||entry.changes.length<1||
      entry.changes.length>10)return null;
   for(const c of entry.changes){
    if(c.field!=='messages'||!PHONE.test(c.value?.metadata?.phone_number_id||''))
     return null;
    const v=c.value,phone=v.metadata.phone_number_id;
    const msgs=Array.isArray(v.messages)?v.messages:[],
     statuses=Array.isArray(v.statuses)?v.statuses:[];
    if((msgs.length===0&&statuses.length===0)||
       msgs.length+statuses.length>100)return null;
    for(const m of msgs){
     if(!META_ID.test(m?.id||''))return null;
     events.push({phone,id:m.id,kind:'MESSAGE',
      digest:crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex')});
    }
    for(const st of statuses){
     if(!META_ID.test(st?.id||'')||!KINDS.has(st?.status))return null;
     events.push({phone,id:st.id,kind:'STATUS_'+st.status.toUpperCase(),
      digest:crypto.createHash('sha256').update(JSON.stringify(st)).digest('hex')});
    }
   }
  }
  return events;
 }
 async function persistSignedEnvelope({rawBody,signature}={}){
  const raw=Buffer.isBuffer(rawBody)?rawBody:null;
  if(!raw||raw.length===0||raw.length>65536)return {state:'INVALID'};
  if(!verifySignature(raw,signature,appSecret))return {state:'UNVERIFIED'};
  const events=parse(raw);
  if(!events)return {state:'INVALID'};
  const sha=crypto.createHash('sha256').update(raw).digest('hex');
  const nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,nonce);
  const ciphertext=Buffer.concat([cipher.update(raw),cipher.final()]);
  const tag=cipher.getAuthTag();
  const c=await pool.connect();
  let active=false;
  try{
   await c.query('BEGIN');active=true;
   const envelope=await c.query('INSERT INTO waba_channel.signed_envelopes '+
    '(envelope_digest,nonce,tag,ciphertext) VALUES($1,$2,$3,$4) '+
    'ON CONFLICT (envelope_digest) DO NOTHING RETURNING envelope_digest',
    [sha,nonce,tag,ciphertext]);
   if(envelope.rowCount===0){
    await c.query('COMMIT');active=false;
    return {state:'DUPLICATE'};
   }
   let fresh=0;
   for(const e of events){
    const result=await c.query('INSERT INTO waba_channel.inbox '+
     '(phone_number_id,message_id,event_kind,event_digest) VALUES($1,$2,$3,$4) '+
     'ON CONFLICT (phone_number_id,message_id,event_kind) DO NOTHING RETURNING message_id',
     [e.phone,e.id,e.kind,e.digest]);
    if(result.rowCount===1){fresh++;continue;}
    const existing=await c.query('SELECT event_digest FROM waba_channel.inbox '+
     'WHERE phone_number_id=$1 AND message_id=$2 AND event_kind=$3',
     [e.phone,e.id,e.kind]);
    if(existing.rowCount!==1||existing.rows[0].event_digest!==e.digest){
     await c.query('ROLLBACK');active=false;
     return {state:'CONFLICT'};
    }
   }
   await c.query('COMMIT');active=false;
   return {state:fresh?'STORED':'DUPLICATE'};
  }catch(_error){
   if(active)try{await c.query('ROLLBACK');}catch(_e){}
   return {state:'UNAVAILABLE'};
  }finally{c.release();}
 }
 return Object.freeze({persistSignedEnvelope,isDurableSignedInbox:true,
  isProcessingEnabled:false});
}
module.exports={createPgSignedInbox};
