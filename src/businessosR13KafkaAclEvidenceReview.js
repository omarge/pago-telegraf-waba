'use strict';
// R13-C: passive checklist for SECURITY UAT observations, never a network
// attestation. Every observation may be fabricated by its caller.
// No credentials, raw broker logs, secrets or payment data are stored.
const TOPIC='businessos.payment.events.v1';
const IDENT=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const REQUIRED=[
 ['consumer','TOPIC','READ',true],
 ['consumer','TOPIC','DESCRIBE',true],
 ['consumer','GROUP','READ',true],
 ['producer','TOPIC','WRITE',true],
 ['producer','GROUP','READ',false],
 ['consumer','TOPIC','WRITE',false],
 ['intruder','TOPIC','WRITE',false],
 ['intruder','TOPIC','READ',false],
 ['intruder','GROUP','READ',false]
];
function reviewR13KafkaAclEvidence(evidence={},{
 expectedTopic=TOPIC,expectedConsumerPrincipal,expectedGroupId
}={}){
 const failures=[];
 const e=evidence&&typeof evidence==='object'&&!Array.isArray(evidence)?
  evidence:{};
 const present=(s)=>typeof s==='string'&&IDENT.test(s);
 if(e.topic!==expectedTopic||e.topic!==TOPIC)failures.push('WRONG_TOPIC');
 if(!present(e.consumerPrincipal)||!present(e.producerPrincipal)||
    !present(e.deniedPrincipal)||!present(e.groupId))
  failures.push('INVALID_PRINCIPAL_OR_GROUP');
 if(e.producerPrincipal!=='payment-engine')
  failures.push('UNEXPECTED_PRODUCER_PRINCIPAL');
 if(e.consumerPrincipal===e.producerPrincipal||
    e.deniedPrincipal===e.consumerPrincipal||
    e.deniedPrincipal===e.producerPrincipal)
  failures.push('PRINCIPAL_SEPARATION_MISSING');
 if(expectedConsumerPrincipal&&e.consumerPrincipal!==expectedConsumerPrincipal)
  failures.push('CONSUMER_PRINCIPAL_MISMATCH');
 if(expectedGroupId&&e.groupId!==expectedGroupId)
  failures.push('GROUP_ID_MISMATCH');
 if(e.tlsPeerVerified!==true||e.tlsHostVerified!==true)
  failures.push('TLS_ATTESTATION_MISSING');
 if(e.scramMechanism!=='SCRAM-SHA-512'||e.scramConsumerLoginObserved!==true)
  failures.push('SCRAM_OBSERVATION_MISSING');
 if(!present(e.uatRunId)||!present(e.brokerClusterId))
  failures.push('UAT_EVIDENCE_ID_MISSING');
 if(e.password!==undefined||e.token!==undefined||e.credentials!==undefined||
    e.privateKey!==undefined||e.sasl?.password!==undefined)
  failures.push('SECRET_MATERIAL_IN_EVIDENCE');
 const checks=Array.isArray(e.aclChecks)?e.aclChecks:[];
 for(const [who,resourceType,operation,authorized] of REQUIRED){
  const principal=e[who==='consumer'?'consumerPrincipal':
   who==='producer'?'producerPrincipal':'deniedPrincipal'];
  const name=resourceType==='TOPIC'?TOPIC:e.groupId;
  if(!checks.some(c=>c&&c.principal===principal&&
     c.resourceType===resourceType&&c.resourceName===name&&
     c.operation===operation&&c.authorized===authorized))
   failures.push('ACL_'+who+'_'+resourceType+'_'+operation+
    (authorized?'_ALLOW_MISSING':'_DENY_MISSING'));
 }
 return Object.freeze({
  state:failures.length?'SECURITY_EVIDENCE_GAPS_HOLD':'SELF_REPORTED_SECURITY_EVIDENCE_HOLD',
  failures:Object.freeze([...new Set(failures)]),
  observedChecks:checks.length,
  isBrokerCertified:false,isAclVerified:false,isSourceAuthenticated:false,
  isPaid:false,canSendReceipt:false,canConnectLive:false,
  productionGo:false,requiresIndependentBrokerAudit:true
 });
}
module.exports={reviewR13KafkaAclEvidence};
