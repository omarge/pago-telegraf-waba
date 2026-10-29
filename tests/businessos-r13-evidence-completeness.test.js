'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewR13EvidenceCompleteness}=
 require('../src/businessosR13EvidenceCompletenessGate');
const TOPIC='businessos.payment.events.v1',principal='waba-r13-reader';
const group='waba-r13-consumer-group';
function config(){return {
 enabled:true,topic:TOPIC,brokers:['kafka.uat.example:9093'],
 clientId:'waba-r13-consumer',groupId:group,
 ssl:{rejectUnauthorized:true},sasl:{mechanism:'scram-sha-512',
  username:principal,password:'offline-placeholder-not-real-123456789'},
 autoCommit:false,eachBatchAutoResolve:false,allowAutoTopicCreation:false};}
function claim(){return {
 tenantId:'tenant-r13',paymentIntentId:'intent-r13',paymentAttemptId:'attempt-r13',
 provider:'openpay',providerTransactionId:'provider-r13',captureStatus:'CAPTURED',
 currency:'MXN',amountCents:'1275',reconciliationId:'recon-r13',
 sourceRevision:'revision-r13',reconciliationStatus:'MATCHED',
 providerProofVerified:true,sourceAuthenticated:true,refundOrUnknownPending:false};}
function acl(){const producer='payment-engine',intruder='intruder-r13';
 const rules=[
 [principal,'TOPIC',TOPIC,'READ',true],
 [principal,'TOPIC',TOPIC,'DESCRIBE',true],
 [principal,'GROUP',group,'READ',true],
 [producer,'TOPIC',TOPIC,'WRITE',true],
 [producer,'GROUP',group,'READ',false],
 [principal,'TOPIC',TOPIC,'WRITE',false],
 [intruder,'TOPIC',TOPIC,'WRITE',false],
 [intruder,'TOPIC',TOPIC,'READ',false],
 [intruder,'GROUP',group,'READ',false]
 ];
 return {
 topic:TOPIC,consumerPrincipal:principal,producerPrincipal:producer,
 deniedPrincipal:intruder,groupId:group,tlsPeerVerified:true,
 tlsHostVerified:true,scramMechanism:'SCRAM-SHA-512',
 scramConsumerLoginObserved:true,uatRunId:'uat-r13-cd',
 brokerClusterId:'cluster-r13-cd',aclChecks:rules.map(
 ([p,resourceType,resourceName,operation,authorized])=>
 ({principal:p,resourceType,resourceName,operation,authorized}))};}
function economic(){return {
 tenantId:'tenant-r13',paymentIntentId:'intent-r13',paymentAttemptId:'attempt-r13',
 providerTransactionId:'provider-r13',reconciliationId:'recon-r13',
 currency:'MXN',amountCents:'1275',captureRevision:'90',
 authoritativeWatermark:'95',adverseEventsWatermark:'95',
 providerCaptureEvidenceId:'proof-r13',captureResult:'CAPTURED',
 reconciliationResult:'MATCHED',unknownCount:0,pendingRefundCount:0,
 pendingDisputeCount:0,sourceProducer:'payment-engine',
 authenticatedSnapshot:true,uatEvidenceRunId:'uat-r13-cd'};}
const expected={
 kafkaExpected:{principal,groupId:group},
 financialExpected:{expectedTenant:'tenant-r13',expectedIntent:'intent-r13',
  expectedAttempt:'attempt-r13',expectedAmountCents:1275},
 coverageExpected:{tenantId:'tenant-r13',paymentIntentId:'intent-r13',
  paymentAttemptId:'attempt-r13',amountCents:1275}
};
function noAuthority(r){
 for(const k of ['isBrokerCertified','isProviderVerified','isReconciled',
  'isPaid','isFinal','canSendReceipt','canSendWhatsApp','canConnectLive',
  'mayCommitKafkaOffset','productionGo'])assert.equal(r[k],false,k);
 assert.equal(r.needsActualSignedBrokerAndProviderAuthority,true);
 assert.equal(Object.isFrozen(r),true);
}
test('R13-CD all self-reported security and economic claims remain HOLD',()=>{
 const r=reviewR13EvidenceCompleteness({...expected,
  kafkaConfig:config(),reconciliationClaim:claim(),
  kafkaAclEvidence:acl(),economicCoverage:economic()});
 assert.equal(r.state,'UNVERIFIED_EVIDENCE_SHAPES_COMPLETE_HOLD');
 assert.deepEqual(r.kafkaFailures,[]);
 assert.deepEqual(r.financialGaps,[]);
 noAuthority(r);
});
test('R13-CD positive capture with untested principal or lagging refunds stays HOLD',()=>{
 const a=acl();a.aclChecks=a.aclChecks.slice(0,7);
 const r=reviewR13EvidenceCompleteness({...expected,
  kafkaConfig:config(),reconciliationClaim:claim(),
  kafkaAclEvidence:a,economicCoverage:{...economic(),
   adverseEventsWatermark:'89',pendingRefundCount:1}});
 assert.equal(r.state,'R13_AUTHORITY_EVIDENCE_GAPS_HOLD');
 assert.ok(r.kafkaFailures.some(x=>x.includes('DENY_MISSING')));
 assert.ok(r.financialGaps.includes('ADVERSE_EVENTS_COVERAGE_LAG'));
 noAuthority(r);
});
test('R13-CD no evidence, no transport and contradictory money always NO_GO',()=>{
 const r=reviewR13EvidenceCompleteness({...expected,
  reconciliationClaim:{...claim(),amountCents:'1276'}});
 assert.equal(r.state,'R13_AUTHORITY_EVIDENCE_GAPS_HOLD');
 assert.ok(r.financialGaps.includes('AMOUNT_MISMATCH'));
 noAuthority(r);
 const empty=reviewR13EvidenceCompleteness();
 noAuthority(empty);
});
