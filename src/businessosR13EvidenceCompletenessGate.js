'use strict';
// R13-CD: combined *self-reported* evidence review. It cannot turn an
// untrusted report into broker identity, provider authority, or PAID.
const {reviewR13OfflineReadiness}=require('./businessosR13OfflineReadinessGate');
const {reviewR13KafkaAclEvidence}=require('./businessosR13KafkaAclEvidenceReview');
const {reviewR13EconomicEvidenceCoverage}=require('./businessosR13EconomicEvidenceCoverage');
function reviewR13EvidenceCompleteness({
 kafkaConfig,reconciliationClaim,kafkaAclEvidence,economicCoverage,
 kafkaExpected={},financialExpected={},coverageExpected={}
}={}){
 const baseline=reviewR13OfflineReadiness({
  kafkaConfig,reconciliationClaim,kafkaExpected,financialExpected});
 const security=reviewR13KafkaAclEvidence(kafkaAclEvidence,{
  expectedTopic:'businessos.payment.events.v1',
  expectedConsumerPrincipal:kafkaExpected.principal,
  expectedGroupId:kafkaExpected.groupId});
 const economic=reviewR13EconomicEvidenceCoverage(economicCoverage,coverageExpected);
 const shapeReady=baseline.state==='OFFLINE_SHAPES_READY_UNTRUSTED_HOLD'&&
  security.state==='SELF_REPORTED_SECURITY_EVIDENCE_HOLD'&&
  economic.state==='SELF_REPORTED_COVERAGE_HOLD';
 return Object.freeze({
  state:shapeReady?'UNVERIFIED_EVIDENCE_SHAPES_COMPLETE_HOLD':
   'R13_AUTHORITY_EVIDENCE_GAPS_HOLD',
  baselineState:baseline.state,securityState:security.state,
  economicState:economic.state,
  kafkaFailures:Object.freeze([...baseline.transportFailures,...security.failures]),
  financialGaps:Object.freeze([...baseline.financialGaps,...economic.problems]),
  isBrokerCertified:false,isProviderVerified:false,isReconciled:false,
  isPaid:false,isFinal:false,canSendReceipt:false,canSendWhatsApp:false,
  canConnectLive:false,mayCommitKafkaOffset:false,productionGo:false,
  needsActualSignedBrokerAndProviderAuthority:true
 });
}
module.exports={reviewR13EvidenceCompleteness};
