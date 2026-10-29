'use strict';
// R12 alternate offline adapter: eachBatch fencing against stop and stale
// assignments. NOT wired into WABA startup. Real broker/ACL UAT still NO_GO.
const {TOPIC,createR12CanonicalWireGate}=require('./businessosR12CanonicalWireGate');
const {createR12CanonicalCaptureInbox}=require('./businessosR12CanonicalCaptureInbox');
const {createR12KafkaCommitProcessor}=require('./businessosR12KafkaCommitProcessor');
const {validateSecureKafkaConfig}=require('./businessosR12SecuredKafkaConsumer');
function createR12RebalanceFencedConsumer({enabled=false,pool,config,kafkaFactory}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'||
    (kafkaFactory!==undefined&&typeof kafkaFactory!=='function'))
  throw Error('R12_REBALANCE_DEPENDENCIES_REQUIRED');
 let consumer=null,connected=false,starting=false,epoch=0;
 const gate=createR12CanonicalWireGate({enabled:true,
  verifyTrustedTransport:async()=>connected});
 const inbox=createR12CanonicalCaptureInbox({enabled:true,pool,wireGate:gate});
 const processor=createR12KafkaCommitProcessor({enabled:true,pool,captureInbox:inbox});
 const live=(generation,isRunning,isStale)=>
  connected&&generation===epoch&&isRunning()===true&&isStale()===false;
 async function stop(){
  // Fence callbacks synchronously, BEFORE awaiting Kafka's async teardown.
  epoch++;connected=false;starting=false;
  const old=consumer;consumer=null;
  if(old){
   try{await old.stop();}catch(_e){}
   try{await old.disconnect();}catch(_e){}
  }
  return {state:'STOPPED_NO_EFFECT'};
 }
 async function start(){
  if(enabled!==true)return {state:'DISABLED'};
  if(starting||consumer)return {state:'ALREADY_STARTED'};
  if(!validateSecureKafkaConfig(config))
   return {state:'CONFIG_REJECTED_NO_CONNECT'};
  starting=true;
  const generation=++epoch;
  let local=null;
  try{
   const Kafka=kafkaFactory||require('kafkajs').Kafka;
   const kafka=new Kafka({
    clientId:config.clientId,brokers:config.brokers,
    ssl:{rejectUnauthorized:true},
    sasl:{mechanism:'scram-sha-512',
     username:config.username,password:config.password}
   });
   local=kafka.consumer({groupId:config.groupId,allowAutoTopicCreation:false});
   consumer=local;
   await local.connect();
   if(generation!==epoch)throw Error('R12_START_FENCED');
   connected=true;
   await local.subscribe({topic:TOPIC,fromBeginning:false});
   if(generation!==epoch)throw Error('R12_START_FENCED');
   await local.run({
    autoCommit:false,eachBatchAutoResolve:false,
    partitionsConsumedConcurrently:1,
    eachBatch:async({batch,resolveOffset,heartbeat,isRunning,isStale})=>{
     if(!batch||batch.topic!==TOPIC||!Array.isArray(batch.messages)||
        typeof resolveOffset!=='function'||typeof heartbeat!=='function'||
        typeof isRunning!=='function'||typeof isStale!=='function')
      throw Error('R12_INVALID_BATCH_NO_COMMIT');
     let last=null;
     for(const message of batch.messages){
      if(!live(generation,isRunning,isStale))return;
      // An in-batch decreasing/repeated offset is not source ordering.
      if(typeof message?.offset!=='string'||! /^(0|[1-9][0-9]*)$/.test(message.offset)||
         (last!==null&&BigInt(message.offset)<=last))
       throw Error('R12_NON_MONOTONIC_OFFSET_HOLD');
      last=BigInt(message.offset);
      const result=await processor.process({
       topic:batch.topic,partition:batch.partition,
       offset:message.offset,key:message.key,headers:message.headers,
       value:message.value
      });
      if(result?.mayCommit!==true)
       throw Error('R12_RECORD_HELD_NO_OFFSET_COMMIT');
      // The DB may commit while Kafka is rebalancing/stopping. Re-check
      // assignment validity after EVERY asynchronous boundary.
      if(!live(generation,isRunning,isStale))return;
      await heartbeat();
      if(!live(generation,isRunning,isStale))return;
      // No automatic offset resolution. Mark only the persisted record.
      resolveOffset(message.offset);
      await local.commitOffsets([{
       topic:batch.topic,partition:batch.partition,
       offset:result.nextOffset
      }]);
     }
    }
   });
   if(generation!==epoch)throw Error('R12_START_FENCED');
   starting=false;
   return {state:'REBALANCE_FENCED_CONSUMER_STARTED_CANDIDATES_ONLY'};
  }catch(_e){
   if(generation===epoch)await stop();
   else if(local&&local!==consumer){
    try{await local.stop();}catch(_ignored){}
    try{await local.disconnect();}catch(_ignored){}
   }
   starting=false;
   return {state:'KAFKA_START_FAILED_NO_EFFECT'};
  }
 }
 return Object.freeze({start,stop,isEnabled:enabled===true,
  isMountedByWaba:false,isRealBrokerCertified:false,
  isEconomicDispatcher:false,isMetaDispatcher:false,isCaptureCertified:false});
}
module.exports={createR12RebalanceFencedConsumer};
