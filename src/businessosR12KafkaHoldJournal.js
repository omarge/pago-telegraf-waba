'use strict';
// No-ACK HOLD journal. NOT a dead-letter queue, skip, quarantine release,
// offset committer, network consumer, financial ledger or live integration.
const crypto=require('node:crypto');
const TOPIC='businessos.payment.events.v1';
const ALLOWED=new Set([
 'INVALID_COORDINATE_HOLD','UNVERIFIED_CANONICAL_HOLD',
 'UNBOUND_OR_AMBIGUOUS_CAPTURE_HOLD','DB_UNAVAILABLE_NO_EFFECT',
 'CAPTURE_INBOX_UNAVAILABLE_HOLD','CAPTURE_INBOX_REJECTED_HOLD',
 'EVENT_ID_OR_OFFSET_COLLISION_HOLD','UNVERIFIED_EVENT_HOLD'
]);
const MAX_OFFSET=9223372036854775807n;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function coordinate({topic,partition,offset}={}){
 if(topic!==TOPIC||!Number.isSafeInteger(partition)||partition<0||
    typeof offset!=='string'||!/^(0|[1-9]\d*)$/.test(offset)||offset.length>19)
  return null;
 const n=BigInt(offset);
 return n<=MAX_OFFSET?{topic,partition,offset:n.toString()}:null;
}
function createR12KafkaHoldJournal({enabled=false,pool}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function')
  throw Error('R12_HOLD_POSTGRES_REQUIRED');
 async function recordHold({record,reason}={}){
  if(enabled!==true)return {state:'DISABLED',mayCommit:false};
  if(!ALLOWED.has(reason))return {state:'INVALID_REASON_HOLD',mayCommit:false};
  // KafkaJS nests the actual record offset under message.offset.
  const c=coordinate({...record,offset:record?.message?.offset});
  const value=record?.message?.value,key=record?.message?.key;
  if(!c||!Buffer.isBuffer(value)||value.length>65536||
     !Buffer.isBuffer(key)||key.length>1024)
   return {state:'UNVERIFIABLE_RECORD_HOLD',mayCommit:false};
  const digest=hash(value),keyDigest=hash(key);
  let db,transaction=false;
  try{
   db=await pool.connect();
   await db.query('BEGIN');transaction=true;
   // A concurrent consumer cannot silently rewrite the first held evidence.
   const found=await db.query(
    'SELECT payload_sha256,key_sha256,reason FROM waba_channel.canonical_kafka_holds '+
    'WHERE topic=$1 AND partition_id=$2 AND record_offset=$3 FOR UPDATE',
    [c.topic,c.partition,c.offset]);
   if(found.rowCount===1){
    const row=found.rows[0];
    if(row.payload_sha256!==digest||row.key_sha256!==keyDigest||
       row.reason!==reason){
     await db.query('ROLLBACK');transaction=false;
     return {state:'HOLD_EVIDENCE_COLLISION',mayCommit:false};
    }
    await db.query(
     'UPDATE waba_channel.canonical_kafka_holds SET observations=observations+1,'+
     'last_seen_at=clock_timestamp() '+
     'WHERE topic=$1 AND partition_id=$2 AND record_offset=$3',
     [c.topic,c.partition,c.offset]);
   }else{
    const saved=await db.query(
     'INSERT INTO waba_channel.canonical_kafka_holds '+
     '(topic,partition_id,record_offset,payload_sha256,key_sha256,reason) '+
     'VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING record_offset',
     [c.topic,c.partition,c.offset,digest,keyDigest,reason]);
    if(saved.rowCount!==1){
     await db.query('ROLLBACK');transaction=false;
     return {state:'HOLD_RETRY_NO_ACK',mayCommit:false};
    }
   }
   await db.query('COMMIT');transaction=false;
   return Object.freeze({state:'DURABLE_HOLD_NO_ACK',mayCommit:false,
    isPaid:false,canSkip:false,canRetryEconomicEffect:false});
  }catch(_e){
   if(transaction)try{await db.query('ROLLBACK');}catch(_ignored){}
   return {state:'HOLD_DB_UNAVAILABLE_NO_ACK',mayCommit:false};
  }finally{if(db)db.release();}
 }
 async function listHeld({limit=20,partition=null}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(!Number.isInteger(limit)||limit<1||limit>100||
     (partition!==null&&(!Number.isSafeInteger(partition)||partition<0)))
   return {state:'INVALID'};
  try{
   const result=await pool.query(
    'SELECT topic,partition_id,record_offset,reason,state,observations,'+
    'first_seen_at,last_seen_at FROM waba_channel.canonical_kafka_holds '+
    'WHERE ($1::integer IS NULL OR partition_id=$1) '+
    'ORDER BY last_seen_at DESC,partition_id,record_offset LIMIT $2',
    [partition,limit]);
   return Object.freeze({state:'HOLD_DIAGNOSTICS_READ_ONLY',
    entries:result.rows.map(r=>Object.freeze({
     topic:r.topic,partition:r.partition_id,offset:String(r.record_offset),
     reason:r.reason,state:r.state,observations:r.observations,
     firstSeenAt:r.first_seen_at,lastSeenAt:r.last_seen_at
    }))});
  }catch(_e){return {state:'DB_UNAVAILABLE_NO_EFFECT'};}
 }
 return Object.freeze({recordHold,listHeld,isEnabled:enabled===true,
  isAutomatic:false,isAckSource:false,isSkipProcessor:false,
  isFinancialDispatcher:false,isNotificationDispatcher:false});
}
function createR12HeldRecordProcessor({processor,journal}={}){
 if(!processor||typeof processor.process!=='function'||!journal||
    typeof journal.recordHold!=='function')
  throw Error('R12_HOLD_DELEGATES_REQUIRED');
 async function process(record){
  let r;
  try{r=await processor.process({
   topic:record?.topic,partition:record?.partition,
   offset:record?.message?.offset,key:record?.message?.key,
   headers:record?.message?.headers,value:record?.message?.value
  });}catch(_e){return {state:'PROCESSOR_UNAVAILABLE_NO_ACK',mayCommit:false};}
  if(r?.mayCommit===true)return r;
  const written=await journal.recordHold({record,reason:r?.state});
  return Object.freeze({state:written.state==='DURABLE_HOLD_NO_ACK'?
   'DURABLE_HOLD_NO_ACK':'UNRESOLVED_HOLD_NO_ACK',mayCommit:false});
 }
 return Object.freeze({process,isAutomatic:false,isEconomicDispatcher:false});
}
module.exports={createR12KafkaHoldJournal,createR12HeldRecordProcessor};
