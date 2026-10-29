'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inspectR12KafkaSecurityEvidence,R12_SECURITY_CHECKS}=require('./kafka-security-preflight');
function manifest(){
 return {
  topic:'businessos.payment.events.v1',
  producerSecurityProtocol:'SASL_SSL',consumerSecurityProtocol:'SASL_SSL',
  producerSaslMechanism:'SCRAM-SHA-512',consumerSaslMechanism:'SCRAM-SHA-512',
  producerPrincipal:'payment-engine',consumerPrincipal:'waba-r12-read-only',
  serverCertificateSha256:'a'.repeat(64),brokerEnvironment:'approved-isolated-uat',
  evidence:R12_SECURITY_CHECKS.map(check=>({
   check,artifactSha256:'b'.repeat(64),runUrl:'https://github.com/example/offline-evidence',
   verifier:'independent-reviewer',outcome:'PASS'
  }))
 };
}
test('R12-H missing evidence never authorizes Kafka connectivity',()=>{
 const a=inspectR12KafkaSecurityEvidence({});
 assert.equal(a.state,'KAFKA_SECURITY_EVIDENCE_HOLD');
 assert.equal(a.canEnableKafka,false);assert.equal(a.securityCertified,false);
});
test('R12-H historical Payment Engine SASL_PLAINTEXT is not TLS evidence',()=>{
 const m=manifest();m.producerSecurityProtocol='SASL_PLAINTEXT';
 const a=inspectR12KafkaSecurityEvidence(m);
 assert.equal(a.state,'KAFKA_SECURITY_EVIDENCE_HOLD');
 assert.ok(a.missing.includes('SASL_SSL_REQUIRED'));
 assert.equal(a.productionGo,false);
});
test('R12-H producer and consumer identities must be different',()=>{
 const m=manifest();m.consumerPrincipal='payment-engine';
 const a=inspectR12KafkaSecurityEvidence(m);
 assert.ok(a.missing.includes('DISTINCT_PRODUCER_CONSUMER_PRINCIPALS'));
});
test('R12-H certificates and ACL/deny evidence must be individually supplied',()=>{
 const m=manifest();m.evidence=m.evidence.filter(e=>e.check!=='unauthorizedProducerDenied');
 const a=inspectR12KafkaSecurityEvidence(m);
 assert.equal(a.canEnableKafka,false);
 assert.ok(a.missing.includes('COMPLETE_EVIDENCE_MATRIX'));
});
test('R12-H do not accept secrets or silently echo input',()=>{
 const m=manifest();m.password='do-not-log-this-value';
 const a=inspectR12KafkaSecurityEvidence(m);
 assert.equal(a.state,'UNRECOGNIZED_OR_SECRET_FIELD_HOLD');
 assert.ok(!JSON.stringify(a).includes(m.password));
});
test('R12-H even perfect self-reported evidence is NOT real broker security certification',()=>{
 const r=inspectR12KafkaSecurityEvidence(manifest());
 assert.equal(r.state,'INDEPENDENT_SECURITY_REVIEW_REQUIRED');
 assert.equal(r.readyForIndependentReview,true);
 assert.equal(r.securityCertified,false);
 assert.equal(r.canEnableKafka,false);
 assert.equal(r.productionGo,false);
 assert.match(r.evidenceDigest,/^[a-f0-9]{64}$/);
});
