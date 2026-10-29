'use strict';
// R12: explicit opt-in secured Kafka consumer shell; NEVER mounted by WABA.
// No producer, Meta/PSP side effects, PAID flag, receipt or finance dispatch.
// Broker ACLs and certificate validation require independent UAT proof.
const {TOPIC,createR12CanonicalWireGate}=require('./businessosR12CanonicalWireGate');
const {createR12CanonicalCaptureInbox}=require('./businessosR12CanonicalCaptureInbox');
const {createR12KafkaCommitProcessor}=require('./businessosR12KafkaCommitProcessor');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const BROKER=/^[A-Za-z0-9][A-Za-z0-9.-]{0,251}:[1-9][0-9]{1,4}$/;
function validateSecureKafkaConfig(config){
 if(!config||typeof config!=='object'||
    !Array.isArray(config.brokers)||config.brokers.length<1||config.brokers.length>8||
    config.brokers.some(x=>typeof x!=='string'||!BROKER.test(x))||
    !ID.test(config.clientId||'')||!ID.test(config.groupId||'')||
    typeof config.username!=='string'||config.username.length<3||
    typeof config.password!=='string'||config.password.length<16||
    config.topic!==TOPIC)return false;
 return true;
}
function createR12SecuredKafkaConsumer({
 enabled=false,pool,config,kafkaFactory
}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function')
  throw Error('R12_KAFKA_PG_REQUIRED');
 if(kafkaFactory!==undefined&&typeof kafkaFactory!=='function')
  throw Error('R12_KAFKA_FACTORY_INVALID');
 let connected=false,consumer=null;
 // Source verification is only true inside an actually connected consumer.
 // Kafka's secured broker authenticates the consumer; the principal's ACLs,
 // upstream producer authenticity and deployment still require external UAT.
 const wireGate=createR12CanonicalWireGate({
  enabled:true,verifyTrustedTransport:async()=>connected
 });
 const captureInbox=createR12CanonicalCaptureInbox({
  enabled:true,pool,wireGate
 });
 const processor=createR12KafkaCommitProcessor({
  enabled:true,pool,captureInbox
 });
 async function stop(){
  connected=false;
  if(consumer){
   try{await consumer.stop();}catch(_e){}
   try{await consumer.disconnect();}catch(_e){}
   consumer=null;
  }
  return {state:'STOPPED_NO_EFFECT'};
 }
 async function start(){
  if(enabled!==true)return {state:'DISABLED'};
  if(consumer!==null)return {state:'ALREADY_STARTED'};
  // Test-only injected transport must NEVER bypass production TLS/SCRAM.
  // NODE_TEST_CONTEXT is supplied by Node's --test child process. This is
  // a guardrail, NOT a cryptographic proof of CI or broker identity.
  if(kafkaFactory!==undefined&&
     !['child-v8','child-process'].includes(process.env.NODE_TEST_CONTEXT))
   return {state:'TEST_TRANSPORT_OVERRIDE_REJECTED_NO_CONNECT'};
  if(!validateSecureKafkaConfig(config))
   return {state:'CONFIG_REJECTED_NO_CONNECT'};
  try{
   // Deliberately lazy: importing this module does not connect anywhere.
   const Kafka= kafkaFactory || require('kafkajs').Kafka;
   const kafka=new Kafka({
    clientId:config.clientId,brokers:config.brokers,
    ssl:{rejectUnauthorized:true},
    sasl:{mechanism:'scram-sha-512',
     username:config.username,password:config.password}
   });
   consumer=kafka.consumer({
    groupId:config.groupId,allowAutoTopicCreation:false
   });
   await consumer.connect();
   connected=true;
   await consumer.subscribe({topic:TOPIC,fromBeginning:false});
   await consumer.run({
    autoCommit:false,partitionsConsumedConcurrently:1,
    eachMessage:async({topic,partition,message})=>{
     // No offset is committed for any record failing domain, money, identity,
     // payload SHA, PostgreSQL audit or capture-candidate persistence.
     const result=await processor.process({
      topic,partition,offset:message?.offset,
      key:message?.key,headers:message?.headers,value:message?.value
     });
     if(result.mayCommit!==true)
      throw Error('R12_KAFKA_RECORD_HELD_NO_OFFSET_COMMIT');
     await consumer.commitOffsets([{topic,partition,offset:result.nextOffset}]);
    }
   });
   return {state:'CONSUMER_STARTED_CANDIDATES_ONLY'};
  }catch(_e){
   await stop();
   return {state:'KAFKA_CONNECT_OR_RUN_FAILED_NO_EFFECT'};
  }
 }
 return Object.freeze({
  start,stop,isEnabled:enabled===true,isMountedByWaba:false,
  isFinancialDispatcher:false,isMetaDispatcher:false,
  isCaptureCertified:false
 });
}
module.exports={validateSecureKafkaConfig,createR12SecuredKafkaConsumer};
