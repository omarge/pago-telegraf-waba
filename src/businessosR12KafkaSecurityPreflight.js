'use strict';
// R12-H: offline security EVIDENCE SHAPE validator only.
// DO NOT use this to create a Kafka client or certify a broker. A caller's
// self-reported evidence is NOT independent principal / ACL / TLS proof.
const crypto=require('node:crypto');
const TOPIC='businessos.payment.events.v1';
const HEX=/^[a-f0-9]{64}$/;
const PRINCIPAL=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const PROTOCOL='SASL_SSL';
const MECH='SCRAM-SHA-512';
const EVIDENCE=[
 'tlsHandshake','serverCertificateChain','consumerAuthentication',
 'producerAuthentication','topicProducerWriteAcl',
 'topicConsumerReadAcl','consumerGroupReadAcl',
 'denyByDefaultAcl','unauthorizedProducerDenied',
 'unauthorizedConsumerDenied','crossTenantIsolation'
];
const FIELD_NAMES=new Set([
 'topic','producerPrincipal','consumerPrincipal','producerSecurityProtocol',
 'consumerSecurityProtocol','producerSaslMechanism','consumerSaslMechanism',
 'serverCertificateSha256','brokerEnvironment','evidence'
]);
const EVIDENCE_FIELDS=new Set(['check','artifactSha256','runUrl','verifier','outcome']);
function cleanEvidence(e){
 if(!e||typeof e!=='object'||Array.isArray(e))return false;
 if(Object.keys(e).some(k=>!EVIDENCE_FIELDS.has(k)))return false;
 return EVIDENCE.includes(e.check)&&HEX.test(e.artifactSha256||'')&&
  typeof e.runUrl==='string'&&/^https:\/\/[^ \n]+$/.test(e.runUrl)&&
  e.runUrl.length<=1024&&PRINCIPAL.test(e.verifier||'')&&
  e.outcome==='PASS';
}
function inspectR12KafkaSecurityEvidence(manifest){
 const missing=new Set();
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))
  return Object.freeze({state:'MALFORMED_MANIFEST_HOLD',readyForIndependentReview:false,
   securityCertified:false,canEnableKafka:false,productionGo:false,
   missing:['MANIFEST']});
 // Never echo input or secrets. Reject even unexpected plaintext credential keys.
 if(Object.keys(manifest).some(k=>!FIELD_NAMES.has(k)))
  return Object.freeze({state:'UNRECOGNIZED_OR_SECRET_FIELD_HOLD',
   readyForIndependentReview:false,securityCertified:false,canEnableKafka:false,
   productionGo:false,missing:['UNRECOGNIZED_FIELD']});
 if(manifest.topic!==TOPIC)missing.add('TOPIC');
 if(manifest.producerSecurityProtocol!==PROTOCOL||
    manifest.consumerSecurityProtocol!==PROTOCOL)
  missing.add('SASL_SSL_REQUIRED');
 if(manifest.producerSaslMechanism!==MECH||
    manifest.consumerSaslMechanism!==MECH)missing.add('SCRAM_SHA_512_REQUIRED');
 if(manifest.producerPrincipal!=='payment-engine'||
    !PRINCIPAL.test(manifest.consumerPrincipal||'')||
    manifest.consumerPrincipal==='payment-engine')
  missing.add('DISTINCT_PRODUCER_CONSUMER_PRINCIPALS');
 if(!HEX.test(manifest.serverCertificateSha256||''))
  missing.add('SERVER_CERTIFICATE_SHA256');
 if(manifest.brokerEnvironment!=='approved-isolated-uat')
  missing.add('APPROVED_ISOLATED_UAT');
 if(!Array.isArray(manifest.evidence)||manifest.evidence.length!==EVIDENCE.length||
    manifest.evidence.some(e=>!cleanEvidence(e)))
  missing.add('COMPLETE_INDEPENDENT_EVIDENCE');
 const entries=Array.isArray(manifest.evidence)?manifest.evidence:[];
 const types=entries.map(e=>e?.check);
 if(new Set(types).size!==EVIDENCE.length||
    EVIDENCE.some(type=>!types.includes(type)))
  missing.add('COMPLETE_EVIDENCE_MATRIX');
 // A structurally valid manifest is ONLY a candidate for human review.
 // Metadata alone cannot prove certificates, ACL or source authentication.
 const ready=missing.size===0;
 return Object.freeze({
  state:ready?'INDEPENDENT_SECURITY_REVIEW_REQUIRED':'KAFKA_SECURITY_EVIDENCE_HOLD',
  readyForIndependentReview:ready,securityCertified:false,
  canEnableKafka:false,productionGo:false,
  missing:Object.freeze([...missing].sort()),
  evidenceDigest:ready?crypto.createHash('sha256')
   .update(JSON.stringify({
    topic:manifest.topic,producer:manifest.producerPrincipal,
    consumer:manifest.consumerPrincipal,ca:manifest.serverCertificateSha256,
    checks:entries.map(e=>[e.check,e.artifactSha256]).sort((a,b)=>a[0].localeCompare(b[0]))
   })).digest('hex'):undefined
 });
}
module.exports={inspectR12KafkaSecurityEvidence,R12_SECURITY_CHECKS:Object.freeze([...EVIDENCE])};
