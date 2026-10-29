'use strict';
// R11 channel pipeline: strictly offline, manually invoked, no outbound effects.
// F09/R5 signed encrypted ingress -> R6 facts -> R7 route -> R8 SAFE MENU staging.
// No automatic cron, financial dispatch, PSP, Meta transport or handler replay.
const {createPgInboxNormalizer}=require('./businessosPgInboxNormalizer');
const {createPgRoutingGate}=require('./businessosPgRoutingGate');
const {createPgSafeMenuOutbox}=require('./businessosPgSafeMenuOutbox');
const SHA=/^[a-f0-9]{64}$/;
const LIMIT=100;
function createR11OfflineInboundPipeline({pool,encryptionKey,enabled=false}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'||
    !Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)
  throw Error('R11_PIPELINE_DEPENDENCIES_REQUIRED');
 const normalizer=createPgInboxNormalizer({pool,encryptionKey});
 const routing=createPgRoutingGate({pool,encryptionKey});
 // No caller-supplied send callback and R8 dispatch is DISABLED; pipeline only
 // creates durable safe-menu intents, never sends them.
 const menu=createPgSafeMenuOutbox({pool,encryptionKey,enabled:false,
  send:async()=>{throw Error('R11_PIPELINE_EXTERNAL_EFFECT_FORBIDDEN');}});
 async function stageEnvelope({envelopeDigest}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(typeof envelopeDigest!=='string'||!SHA.test(envelopeDigest))
   return {state:'INVALID'};
  const norm=await normalizer.processNext({envelopeDigest});
  if(norm.state==='RETRYABLE_NO_EFFECT')return {state:'RETRYABLE_NO_EFFECT'};
  if(norm.state==='QUARANTINED')return {state:'QUARANTINED_NO_EFFECT'};
  if(norm.state!=='NORMALIZED'&&norm.state!=='EMPTY')
   return {state:'HALTED_NO_EFFECT'};
  let routeCount=0;
  for(let i=0;i<LIMIT;i++){
   const routed=await routing.stageNext({sourceEnvelopeDigest:envelopeDigest});
   if(routed.state==='EMPTY')break;
   if(routed.state!=='STAGED_NO_EFFECT')
    return {state:'RETRYABLE_NO_EFFECT'};
   routeCount++;
  }
  // Read-only selection of already committed R7 facts; recovers a crash
  // between R7 COMMIT and R8 safe-menu staging on the next invocation.
  let rows;
  try{
   rows=await pool.query(
    'SELECT r.phone_number_id,r.message_id FROM waba_channel.routing_decisions r '+
    'JOIN waba_channel.signed_envelopes e ON e.envelope_digest=r.source_envelope_digest '+
    'WHERE r.source_envelope_digest=$1 AND r.event_kind=$2 '+
    'AND r.route_code=$3 AND e.normalized_at IS NOT NULL AND e.quarantined_at IS NULL '+
    'ORDER BY r.created_at,r.phone_number_id,r.message_id LIMIT $4',
    [envelopeDigest,'MESSAGE','MENU_CANDIDATE',LIMIT]);
  }catch(_e){return {state:'RETRYABLE_NO_EFFECT'};}
  let menus=0;
  for(const item of rows.rows){
   const out=await menu.stage({phoneNumberId:item.phone_number_id,
    messageId:item.message_id});
   if(out.state==='STAGED')menus++;
   else if(out.state!=='ALREADY_STAGED')
    return {state:'RETRYABLE_NO_EFFECT'};
  }
  // A full batch may hide more pending facts; the operator must invoke again.
  return Object.freeze({state:routeCount===LIMIT||rows.rowCount===LIMIT?
   'PARTIAL_OFFLINE_NO_DISPATCH':'STAGED_OFFLINE_NO_DISPATCH',
   routes:routeCount,menuIntents:menus,financialActions:0,metaSends:0});
 }
 return Object.freeze({stageEnvelope,isEnabled:enabled===true,
  hasExternalEffects:false,isFinancialDispatcher:false,isMetaDispatcher:false});
}
module.exports={createR11OfflineInboundPipeline};
