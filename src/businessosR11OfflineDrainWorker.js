'use strict';
// Bounded, pull-only R5→R6→R7→R8 recovery worker.
// It scans durable *database commitments*, never raw HTTP or user-supplied
// instructions. No Meta transport, financial dispatcher, cron or timers.
// A supervisor may invoke runOnce repeatedly only after separate approval.
const {createR11OfflineInboundPipeline}=require('./businessosR11OfflineInboundPipeline');
const SHA=/^[a-f0-9]{64}$/;
const MAX_BATCH=32;
function createR11OfflineDrainWorker({pool,encryptionKey,enabled=false}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'||
    !Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)
  throw Error('R11_DRAIN_WORKER_DEPENDENCIES_REQUIRED');
 const pipeline=createR11OfflineInboundPipeline({pool,encryptionKey,enabled:true});
 async function runOnce({limit=8,envelopeDigest=null}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(!Number.isInteger(limit)||limit<1||limit>MAX_BATCH||
     (envelopeDigest!==null&&(!SHA.test(envelopeDigest))))
   return {state:'INVALID'};
  let selected;
  try{
   // A candidate remains eligible after any interrupted boundary:
   // - signed envelope not normalized,
   // - normalized fact not yet classified, OR
   // - safe-menu routing intent not durably staged.
   // Quarantined envelopes never get retried automatically.
   selected=await pool.query(
    'SELECT e.envelope_digest FROM waba_channel.signed_envelopes e '+
    'WHERE e.quarantined_at IS NULL '+
    'AND ($1::text IS NULL OR e.envelope_digest=$1) '+
    'AND (e.normalized_at IS NULL OR EXISTS ('+
    'SELECT 1 FROM waba_channel.normalized_inbox_events n '+
    'WHERE n.source_envelope_digest=e.envelope_digest AND NOT EXISTS ('+
    'SELECT 1 FROM waba_channel.routing_decisions r '+
    'WHERE r.phone_number_id=n.phone_number_id AND r.message_id=n.message_id '+
    'AND r.event_kind=n.event_kind)) OR EXISTS ('+
    'SELECT 1 FROM waba_channel.routing_decisions r '+
    'WHERE r.source_envelope_digest=e.envelope_digest '+
    "AND r.event_kind='MESSAGE' AND r.route_code='MENU_CANDIDATE' "+ 
    'AND NOT EXISTS (SELECT 1 FROM waba_channel.safe_menu_outbox o '+
    'WHERE o.phone_number_id=r.phone_number_id AND o.message_id=r.message_id '+
    'AND o.event_kind=r.event_kind))) '+
    'ORDER BY e.received_at,e.envelope_digest LIMIT $2',
    [envelopeDigest,limit]);
  }catch(_e){return {state:'RETRYABLE_NO_EFFECT'};}
  if(selected.rowCount===0)return {
   state:'IDLE_NO_EFFECT',envelopes:0,routes:0,menuIntents:0,
   financialActions:0,metaSends:0};
  let envelopes=0,routes=0,menuIntents=0,more=false;
  for(const item of selected.rows){
   const result=await pipeline.stageEnvelope({envelopeDigest:item.envelope_digest});
   if(result.state==='RETRYABLE_NO_EFFECT'||result.state==='HALTED_NO_EFFECT')
    return {state:result.state,envelopes,routes,menuIntents,
     financialActions:0,metaSends:0};
   if(result.state==='QUARANTINED_NO_EFFECT'){
    envelopes++;continue;
   }
   if(result.state!=='STAGED_OFFLINE_NO_DISPATCH'&&
      result.state!=='PARTIAL_OFFLINE_NO_DISPATCH')
    return {state:'HALTED_NO_EFFECT',envelopes,routes,menuIntents,
     financialActions:0,metaSends:0};
   envelopes++;
   routes+=result.routes;
   menuIntents+=result.menuIntents;
   if(result.state==='PARTIAL_OFFLINE_NO_DISPATCH')more=true;
  }
  // The limit is a bound, not a guarantee that all backlog was scanned.
  // A caller may retry after this; no side effects or redispatch are possible.
  return Object.freeze({
   state:more||selected.rowCount===limit?
    'MORE_WORK_OFFLINE_NO_DISPATCH':'DRAINED_OFFLINE_NO_DISPATCH',
   envelopes,routes,menuIntents,financialActions:0,metaSends:0});
 }
 return Object.freeze({runOnce,isEnabled:enabled===true,
  isAutomatic:false,hasExternalEffects:false,
  isFinancialDispatcher:false,isMetaDispatcher:false});
}
module.exports={createR11OfflineDrainWorker};
