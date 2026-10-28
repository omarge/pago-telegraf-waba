'use strict';
// R6: transactional, side-effect-free normalization of R5 encrypted inbox.
// Never invokes Meta, Openpay, BusinessOS, onWebhook, or any network APIs.
// PostgreSQL FOR UPDATE SKIP LOCKED makes concurrent workers mutually exclusive.
const crypto=require('node:crypto');
const {extractEvents}=require('./businessosPgSignedInbox');
function createPgInboxNormalizer({pool,encryptionKey}={}){
 if(!pool||typeof pool.connect!=='function'||
    !Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)
  throw Error('R6_CONFIG_INVALID');
 async function processNext({envelopeDigest=null}={}){
  if(envelopeDigest!==null&&
     (typeof envelopeDigest!=='string'||!/^[a-f0-9]{64}$/.test(envelopeDigest)))
   return {state:'INVALID'};
  const c=await pool.connect();
  let active=false;
  try{
   await c.query('BEGIN');active=true;
   const found=await c.query(
    'SELECT envelope_digest,nonce,tag,ciphertext FROM waba_channel.signed_envelopes '+
    'WHERE normalized_at IS NULL AND quarantined_at IS NULL '+
    'AND ($1::text IS NULL OR envelope_digest=$1) '+
    'ORDER BY received_at,envelope_digest FOR UPDATE SKIP LOCKED LIMIT 1',
    [envelopeDigest]);
   if(found.rowCount===0){
    await c.query('COMMIT');active=false;return {state:'EMPTY'};
   }
   const item=found.rows[0];
   async function quarantine(code){
    await c.query('UPDATE waba_channel.signed_envelopes '+
     'SET quarantined_at=clock_timestamp(),quarantine_code=$2 '+
     'WHERE envelope_digest=$1',
     [item.envelope_digest,code]);
    await c.query('COMMIT');active=false;
    return {state:'QUARANTINED',code};
   }
   let raw;
   try{
    const d=crypto.createDecipheriv('aes-256-gcm',encryptionKey,item.nonce);
    d.setAuthTag(item.tag);
    raw=Buffer.concat([d.update(item.ciphertext),d.final()]);
   }catch(_error){return quarantine('AUTHENTICATION_FAILED');}
   const digest=crypto.createHash('sha256').update(raw).digest('hex');
   if(digest!==item.envelope_digest)return quarantine('DIGEST_MISMATCH');
   const events=extractEvents(raw);
   if(!events||events.length===0)return quarantine('ENVELOPE_INVALID');
   // Check original signed-ingress identities before recording any facts.
   // No partial writes if one item has vanished or been tampered with.
   for(const event of events){
    const result=await c.query(
     'SELECT event_digest FROM waba_channel.inbox '+
     'WHERE phone_number_id=$1 AND message_id=$2 AND event_kind=$3',
     [event.phone,event.id,event.kind]);
    if(result.rowCount!==1||result.rows[0].event_digest!==event.digest)
     return quarantine('INBOX_IDENTITY_MISMATCH');
   }
   let normalized=0,duplicates=0;
   for(const event of events){
    const result=await c.query(
     'INSERT INTO waba_channel.normalized_inbox_events '+
     '(phone_number_id,message_id,event_kind,event_digest,source_envelope_digest) '+
     'VALUES($1,$2,$3,$4,$5) '+
     'ON CONFLICT (phone_number_id,message_id,event_kind) DO NOTHING '+
     'RETURNING message_id',
     [event.phone,event.id,event.kind,event.digest,item.envelope_digest]);
    if(result.rowCount===1){normalized++;continue;}
    const existing=await c.query(
     'SELECT event_digest FROM waba_channel.normalized_inbox_events '+
     'WHERE phone_number_id=$1 AND message_id=$2 AND event_kind=$3',
     [event.phone,event.id,event.kind]);
    // Concurrent content divergence must ROLLBACK this transaction.
    if(existing.rowCount!==1||existing.rows[0].event_digest!==event.digest)
     throw Error('R6_NORMALIZED_FACT_CONFLICT');
    duplicates++;
   }
   await c.query('UPDATE waba_channel.signed_envelopes SET normalized_at=clock_timestamp() '+
    'WHERE envelope_digest=$1 AND normalized_at IS NULL AND quarantined_at IS NULL',
    [item.envelope_digest]);
   await c.query('COMMIT');active=false;
   return {state:'NORMALIZED',facts:normalized,duplicates};
  }catch(_error){
   if(active)try{await c.query('ROLLBACK');}catch(_ignored){}
   // DB faults and partial-transaction failures are retryable; no external
   // effect occurred. Do not expose encrypted payloads or SQL errors.
   return {state:'RETRYABLE_NO_EFFECT'};
  }finally{c.release();}
 }
 return Object.freeze({processNext,isOfflineNormalizer:true,hasExternalEffects:false});
}
module.exports={createPgInboxNormalizer};
