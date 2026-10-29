'use strict';
// Strict read-only deployment configuration preflight. No Kafka connections.
// This does not attest to ACLs, broker certificates or source ownership.
const TOPIC='businessos.payment.events.v1';
const FQDN=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:[1-9][0-9]{1,4}$/i;
const NAME=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
function assessR13KafkaDeployment(config,expected={}){
 const fail=[];
 if(!config||typeof config!=='object'||Array.isArray(config))
  return Object.freeze({state:'CONFIG_HOLD',failures:['INVALID_CONFIG'],
   mayConnect:false,isBrokerCertified:false,productionGo:false});
 if(config.enabled!==true)fail.push('DARK_MODE');
 if(config.topic!==TOPIC)fail.push('WRONG_TOPIC');
 if(!Array.isArray(config.brokers)||config.brokers.length<1||
    config.brokers.length>8||config.brokers.some(x=>typeof x!=='string'||!FQDN.test(x)))
  fail.push('INVALID_BROKERS');
 if(!NAME.test(config.clientId||'')||!NAME.test(config.groupId||''))
  fail.push('INVALID_PRINCIPAL_IDENTIFIERS');
 if(config.ssl?.rejectUnauthorized!==true||config.ssl?.rejectUnauthorized===false)
  fail.push('TLS_VERIFICATION_REQUIRED');
 if(config.sasl?.mechanism!=='scram-sha-512'||typeof config.sasl?.username!=='string'||
    config.sasl.username.length<3||typeof config.sasl?.password!=='string'||
    config.sasl.password.length<16)fail.push('SCRAM512_REQUIRED');
 if(config.autoCommit!==false||config.eachBatchAutoResolve!==false)
  fail.push('MANUAL_OFFSET_REQUIRED');
 if(config.allowAutoTopicCreation!==false)fail.push('AUTO_TOPIC_CREATION_FORBIDDEN');
 if(config.kafkaFactory!==undefined||config.skipTlsVerification===true)
  fail.push('TEST_TRANSPORT_FORBIDDEN');
 if(expected.clientId&&config.clientId!==expected.clientId)
  fail.push('CLIENT_ID_NOT_PINNED');
 if(expected.groupId&&config.groupId!==expected.groupId)
  fail.push('GROUP_ID_NOT_PINNED');
 if(expected.principal&&config.sasl?.username!==expected.principal)
  fail.push('PRINCIPAL_NOT_PINNED');
 // A local config snapshot cannot validate a real broker or authorize PAID.
 return Object.freeze({state:fail.length?'CONFIG_HOLD':'CONFIG_SHAPE_ONLY',
  failures:Object.freeze([...new Set(fail)]),
  mayConnect:false,isBrokerCertified:false,isProducerAuthenticated:false,
  isAclVerified:false,isTlsHandshakeVerified:false,productionGo:false});
}
module.exports={assessR13KafkaDeployment};
