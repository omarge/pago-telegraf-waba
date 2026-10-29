'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewR13KafkaAclEvidence}=require('../src/businessosR13KafkaAclEvidenceReview');
const topic='businessos.payment.events.v1';
const client='waba-reader',producer='payment-engine',intruder='untrusted-user',group='waba-group';
const rules=[
 [client,'TOPIC',topic,'READ',true],
 [client,'TOPIC',topic,'DESCRIBE',true],
 [client,'GROUP',group,'READ',true],
 [producer,'TOPIC',topic,'WRITE',true],
 [producer,'GROUP',group,'READ',false],
 [client,'TOPIC',topic,'WRITE',false],
 [intruder,'TOPIC',topic,'WRITE',false],
 [intruder,'TOPIC',topic,'READ',false],
 [intruder,'GROUP',group,'READ',false]
];
function fixture(){return {
 topic,consumerPrincipal:client,producerPrincipal:producer,deniedPrincipal:intruder,
 groupId:group,tlsPeerVerified:true,tlsHostVerified:true,
 scramMechanism:'SCRAM-SHA-512',scramConsumerLoginObserved:true,
 uatRunId:'r13c-uat-offline',brokerClusterId:'offline-kafka-cluster',
 aclChecks:rules.map(([principal,resourceType,resourceName,operation,authorized])=>
  ({principal,resourceType,resourceName,operation,authorized}))
};}
const pins={expectedTopic:topic,expectedConsumerPrincipal:client,expectedGroupId:group};
test('R13-C self-reported ACL evidence NEVER certifies broker or PAID',()=>{
 const r=reviewR13KafkaAclEvidence(fixture(),pins);
 assert.equal(r.state,'SELF_REPORTED_SECURITY_EVIDENCE_HOLD');
 assert.deepEqual(r.failures,[]);
 assert.equal(r.observedChecks,9);
 assert.equal(r.isBrokerCertified,false);
 assert.equal(r.isAclVerified,false);
 assert.equal(r.productionGo,false);
 assert.equal(r.canConnectLive,false);
 assert.equal(r.requiresIndependentBrokerAudit,true);
});
test('R13-C claimed ACL cannot omit denial to intruder or consumer WRITE',()=>{
 const x=fixture();
 x.aclChecks=x.aclChecks.filter(r=>!(r.principal===intruder&&r.operation==='READ')&&
  !(r.principal===client&&r.operation==='WRITE'));
 const r=reviewR13KafkaAclEvidence(x,pins);
 assert.equal(r.state,'SECURITY_EVIDENCE_GAPS_HOLD');
 assert.ok(r.failures.includes('ACL_intruder_TOPIC_READ_DENY_MISSING'));
 assert.ok(r.failures.includes('ACL_intruder_GROUP_READ_DENY_MISSING'));
 assert.ok(r.failures.includes('ACL_consumer_TOPIC_WRITE_DENY_MISSING'));
});
test('R13-C producer impersonation, missing TLS and SCRAM fail closed',()=>{
 const x={...fixture(),producerPrincipal:client,tlsHostVerified:false,
  scramMechanism:'PLAIN'};
 const r=reviewR13KafkaAclEvidence(x,pins);
 for(const v of ['UNEXPECTED_PRODUCER_PRINCIPAL','PRINCIPAL_SEPARATION_MISSING',
  'TLS_ATTESTATION_MISSING','SCRAM_OBSERVATION_MISSING'])
  assert.ok(r.failures.includes(v),v);
 assert.equal(r.isSourceAuthenticated,false);
});
test('R13-C rejects secret material and malformed metadata without leaking values',()=>{
 const x={...fixture(),password:'DO_NOT_ECHO_SECRET',topic:'another.topic',groupId:'unknown'};
 const r=reviewR13KafkaAclEvidence(x,pins);
 assert.ok(r.failures.includes('SECRET_MATERIAL_IN_EVIDENCE'));
 assert.ok(r.failures.includes('WRONG_TOPIC'));
 assert.ok(r.failures.includes('GROUP_ID_MISMATCH'));
 assert.equal(JSON.stringify(r).includes('DO_NOT_ECHO_SECRET'),false);
 const empty=reviewR13KafkaAclEvidence(null,pins);
 assert.equal(empty.state,'SECURITY_EVIDENCE_GAPS_HOLD');
 assert.equal(empty.productionGo,false);
});
