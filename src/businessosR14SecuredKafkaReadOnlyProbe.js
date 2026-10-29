'use strict';
// Optional R14 live Kafka metadata / ACL *inspection* only.
// NEVER mounted in WABA runtime, never starts a consumer or producer,
// never reads messages, commits offsets, or sends financial notifications.
// Keep metadata-only inspection zero-dependency in dark mode and offline CI.
// R12's consumer pulls in protobufjs; importing it here would inflate a
// five-second security job into an unnecessary application install.
const CLIENT=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const BROKER=/^[A-Za-z0-9][A-Za-z0-9.-]{0,251}:[1-9][0-9]{1,4}$/;
function validateProbeConfig(config){
 return !!config&&typeof config==='object'&&
  Array.isArray(config.brokers)&&config.brokers.length>=1&&
  config.brokers.length<=8&&config.brokers.every(x=>
   typeof x==='string'&&BROKER.test(x))&&
  CLIENT.test(config.clientId||'')&&CLIENT.test(config.groupId||'')&&
  typeof config.username==='string'&&config.username.length>=3&&
  typeof config.password==='string'&&config.password.length>=16&&
  config.topic==='businessos.payment.events.v1';
}
const TOPIC='businessos.payment.events.v1';
const SAFE_STATES=new Set([
 'DISABLED_NO_NETWORK','CONFIG_REJECTED_NO_NETWORK',
 'TEST_FACTORY_REFUSED_NO_NETWORK','BROKER_CONNECT_OR_METADATA_HOLD',
 'TOPIC_NOT_FOUND_HOLD','ACL_INSPECTION_UNAVAILABLE_HOLD',
 'BROKER_METADATA_OBSERVED_PENDING_INDEPENDENT_AUDIT'
]);
function response(state,extra={}){
 if(!SAFE_STATES.has(state))throw Error('R14_UNEXPECTED_STATE');
 return Object.freeze({
  state,...extra,
  isBrokerCertified:false,isAclCertified:false,
  isProducerAuthenticated:false,isPaymentFinal:false,
  isPaid:false,canSendReceipt:false,canSendWhatsApp:false,
  mayConsumeMessages:false,mayCommitOffsets:false,
  productionGo:false
 });
}
function createR14SecuredKafkaReadOnlyProbe({enabled=false,config,kafkaFactory}={}){
 async function inspect(){
  if(enabled!==true)return response('DISABLED_NO_NETWORK');
  if(kafkaFactory!==undefined&&
    (typeof kafkaFactory!=='function'||
     !['child-v8','child-process'].includes(process.env.NODE_TEST_CONTEXT)))
   return response('TEST_FACTORY_REFUSED_NO_NETWORK');
  const ca=config?.tlsCaPem;
  if(ca!==undefined&&(!Array.isArray(ca)||ca.length<1||ca.length>5||
    !ca.every(x=>typeof x==='string'&&x.includes('BEGIN CERTIFICATE')&&
      x.includes('END CERTIFICATE')&&x.length<16384)))
   return response('CONFIG_REJECTED_NO_NETWORK');
  if(!validateProbeConfig(config)||
     config?.ssl?.rejectUnauthorized===false||
     config?.skipTlsVerification===true||
     config?.sasl?.mechanism&&config.sasl.mechanism!=='scram-sha-512')
   return response('CONFIG_REJECTED_NO_NETWORK');
  let admin,connected=false;
  try{
   // Lazy import: no Kafka package or network is needed in dark mode.
   const kafkaLib=kafkaFactory?null:require('kafkajs');
   const Kafka=kafkaFactory||kafkaLib.Kafka;
   const settings={
    clientId:config.clientId,brokers:config.brokers,
    connectionTimeout:3500,requestTimeout:7000,retry:{retries:0},
    ssl:{rejectUnauthorized:true},
    sasl:{mechanism:'scram-sha-512',
     username:config.username,password:config.password}
   };
   if(ca!==undefined)settings.ssl.ca=ca;
   const kafka=new Kafka(settings);
   admin=kafka.admin();
   await admin.connect();
   connected=true;
   const md=await admin.fetchTopicMetadata({topics:[TOPIC]});
   const topic=(md?.topics||[]).find(x=>x.name===TOPIC);
   if(!topic||!Array.isArray(topic.partitions)||!topic.partitions.length)
    return response('TOPIC_NOT_FOUND_HOLD');
   // ACL listing is often deliberately forbidden to a least-privilege
   // consumer. No response does NOT mean permission was granted.
   let acl;
   try{
    const C=kafkaFactory?{
     AclResourceTypes:{TOPIC:2},AclOperationTypes:{ANY:1},
     AclPermissionTypes:{ANY:1},ResourcePatternTypes:{ANY:1}
    }:kafkaLib;
    acl=await admin.describeAcls({
     resourceName:TOPIC,resourceType:C.AclResourceTypes.TOPIC,
     operation:C.AclOperationTypes.ANY,
     permissionType:C.AclPermissionTypes.ANY,
     resourcePatternTypeFilter:C.ResourcePatternTypes.ANY
    });
   }catch(_err){
    return response('ACL_INSPECTION_UNAVAILABLE_HOLD',{
     topicMetadataObserved:true,partitionCount:topic.partitions.length
    });
   }
   if(!Array.isArray(acl?.resources))
    return response('ACL_INSPECTION_UNAVAILABLE_HOLD',{
     topicMetadataObserved:true,partitionCount:topic.partitions.length
    });
   // Do not export ACL principals/hosts, TLS certs, secrets or broker IDs.
   return response('BROKER_METADATA_OBSERVED_PENDING_INDEPENDENT_AUDIT',{
    topicMetadataObserved:true,partitionCount:topic.partitions.length,
    aclDescriptionReturned:true
   });
  }catch(_err){
   return response('BROKER_CONNECT_OR_METADATA_HOLD');
  }finally{
   if(connected&&admin)try{await admin.disconnect();}catch(_ignored){}
  }
 }
 return Object.freeze({inspect,isEnabled:enabled===true,
  isMountedByWaba:false,isMessageConsumer:false,
  isProducer:false,isFinancialAuthority:false});
}
module.exports={createR14SecuredKafkaReadOnlyProbe};
