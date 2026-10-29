'use strict';
// R7 classification gate, NOT a message sender or financial dispatcher.
// Inputs are PostgreSQL R6 normalized facts and R5 authenticated AES-GCM
// envelopes; all work is enclosed in one serializable-by-row transaction.
const crypto=require('node:crypto');
const {extractEvents}=require('./businessosPgSignedInbox');
const ID=/^[A-Za-z0-9._:-]{4,255}$/;
function classification(raw,item){
 let parsed;
 try{parsed=JSON.parse(raw.toString('utf8'));}
 catch(_e){return 'REQUIRES_REVIEW';}
 const events=extractEvents(raw);
 if(!events||!events.some(e=>e.phone===item.phone_number_id&&
    e.id===item.message_id&&e.kind===item.event_kind&&
    e.digest===item.event_digest))return 'REQUIRES_REVIEW';
 if(item.event_kind!=='MESSAGE')return 'IGNORED_STATUS';
 const messages=[];
 for(const entry of parsed.entry||[]){
  for(const change of entry.changes||[]){
   if(change.value?.metadata?.phone_number_id!==item.phone_number_id)continue;
   for(const m of change.value.messages||[]){
    if(m.id===item.message_id)messages.push(m);
   }
  }
 }
 if(messages.length!==1)return 'REQUIRES_REVIEW';
 const m=messages[0];
 if(m.type!=='text'||typeof m.text?.body!=='string')
  return 'IGNORED_UNKNOWN';
 const cmd=m.text.body.trim().toLowerCase();
 if(cmd==='menu'||cmd==='menú')return 'MENU_CANDIDATE';
 if(['cobrar','pagar','tarjetas','nip','estado de cuenta',
      'configuracion','configuración'].includes(cmd))
  return 'AWAITING_SECURITY_ENGINE';
 return 'IGNORED_UNKNOWN';
}
function createPgRoutingGate({pool,encryptionKey}={}){
 if(!pool||typeof pool.connect!=='function'||
    !Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)
  throw Error('R7_ROUTING_CONFIG');
 async function stageNext({messageId=null,sourceEnvelopeDigest=null}={}){
  if(sourceEnvelopeDigest!==null&&
     (typeof sourceEnvelopeDigest!=='string'||!/^[a-f0-9]{64}$/.test(sourceEnvelopeDigest)))
   return {state:'INVALID'};
  if(messageId!==null&&(typeof messageId!=='string'||!ID.test(messageId)))
   return {state:'INVALID'};
  let c;
  try{c=await pool.connect();}
  catch(_e){return {state:'RETRYABLE_NO_EFFECT'};}
  let active=false;
  try{
   await c.query('BEGIN');active=true;
   const found=await c.query(
    'SELECT n.phone_number_id,n.message_id,n.event_kind,n.event_digest,'+
    'n.source_envelope_digest,e.nonce,e.tag,e.ciphertext '+
    'FROM waba_channel.normalized_inbox_events n '+
    'JOIN waba_channel.signed_envelopes e '+
    'ON e.envelope_digest=n.source_envelope_digest '+
    'WHERE e.normalized_at IS NOT NULL AND e.quarantined_at IS NULL '+
    'AND NOT EXISTS(SELECT 1 FROM waba_channel.routing_decisions d '+
    'WHERE d.phone_number_id=n.phone_number_id AND d.message_id=n.message_id '+
    'AND d.event_kind=n.event_kind) '+
    'AND ($1::text IS NULL OR n.message_id=$1) '+
   'AND ($2::text IS NULL OR n.source_envelope_digest=$2) '+
    'ORDER BY n.normalized_at,n.phone_number_id,n.message_id,n.event_kind '+
    'FOR UPDATE OF n SKIP LOCKED LIMIT 1',
    [messageId,sourceEnvelopeDigest]);
   if(found.rowCount===0){
    await c.query('COMMIT');active=false;return {state:'EMPTY'};
   }
   const item=found.rows[0];
   let code='REQUIRES_REVIEW';
   try{
    const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,item.nonce);
    decipher.setAuthTag(item.tag);
    const raw=Buffer.concat([decipher.update(item.ciphertext),decipher.final()]);
    if(crypto.createHash('sha256').update(raw).digest('hex')===item.source_envelope_digest)
     code=classification(raw,item);
   }catch(_e){} // Corrupt encrypted input is REQUIRES_REVIEW, never dispatch.
   const result=await c.query(
    'INSERT INTO waba_channel.routing_decisions '+
    '(phone_number_id,message_id,event_kind,event_digest,source_envelope_digest,route_code) '+
    'VALUES($1,$2,$3,$4,$5,$6) '+
    'ON CONFLICT (phone_number_id,message_id,event_kind) DO NOTHING RETURNING route_code',
    [item.phone_number_id,item.message_id,item.event_kind,item.event_digest,
     item.source_envelope_digest,code]);
   await c.query('COMMIT');active=false;
   return result.rowCount===1?{state:'STAGED_NO_EFFECT',routeCode:code,
    phoneNumberId:item.phone_number_id,messageId:item.message_id,eventKind:item.event_kind}:
    {state:'DUPLICATE_NO_EFFECT'};
  }catch(_e){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   return {state:'RETRYABLE_NO_EFFECT'};
  }finally{c.release();}
 }
 return Object.freeze({stageNext,isOfflineRoutingGate:true,
  isExternallyDispatching:false});
}
module.exports={createPgRoutingGate,classification};
