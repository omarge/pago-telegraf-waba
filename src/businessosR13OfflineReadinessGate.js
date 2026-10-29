'use strict';
// R13 A+B: strictly non-authoritative joint readiness assessment.
// The existence of a TLS/SCRAM configuration and a claimed "MATCHED" capture
// is insufficient to release PAID, receipts, WhatsApp, or production.
const {assessR13KafkaDeployment}=require('./businessosR13KafkaDeploymentPreflight');
const {reviewR13ReconciliationClaim}=require('./businessosR13ReconciliationAuthorityContract');

function reviewR13OfflineReadiness({kafkaConfig,reconciliationClaim,
 kafkaExpected={},financialExpected={}}={}){
 const transport=assessR13KafkaDeployment(kafkaConfig,kafkaExpected);
 const finance=reviewR13ReconciliationClaim(reconciliationClaim,financialExpected);
 const shapeComplete=transport.state==='CONFIG_SHAPE_ONLY'&&
  finance.state==='CLAIM_SHAPE_ONLY_NO_FINALITY';
 return Object.freeze({
  state:shapeComplete?'OFFLINE_SHAPES_READY_UNTRUSTED_HOLD':'R13_UNVERIFIED_INPUT_HOLD',
  transportState:transport.state,financeState:finance.state,
  transportFailures:Object.freeze([...(transport.failures||[])]),
  financialGaps:Object.freeze([...(finance.gaps||[])]),
  isPaid:false,isFinal:false,isReconciled:false,
  isBrokerCertified:false,isProviderVerified:false,
  canSendReceipt:false,canSendWhatsApp:false,
  canConnectLive:false,mayCommitKafkaOffset:false,
  productionGo:false,requiresExternalAuthority:true
 });
}
module.exports={reviewR13OfflineReadiness};
