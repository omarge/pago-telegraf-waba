'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {reviewR13OfflineReadiness}=require('../src/businessosR13OfflineReadinessGate');
function config(){return {
 enabled:true,topic:'businessos.payment.events.v1',
 brokers:['broker.offline.example:9093'],clientId:'r13-waba-candidate',
 groupId:'r13-waba-candidate-group',
 ssl:{rejectUnauthorized:true},
 sasl:{mechanism:'scram-sha-512',username:'waba-r13-reader',
  password:'mock-only-not-a-real-password-1234'},
 autoCommit:false,eachBatchAutoResolve:false,allowAutoTopicCreation:false
};}
function claim(){return {
 tenantId:'r13-tenant',paymentIntentId:'r13-intent',paymentAttemptId:'r13-attempt',
 provider:'openpay',providerTransactionId:'r13-provider-transaction',
 captureStatus:'CAPTURED',currency:'MXN',amountCents:'1275',
 reconciliationId:'r13-reconciliation',sourceRevision:'r13-revision',
 reconciliationStatus:'MATCHED',providerProofVerified:true,
 sourceAuthenticated:true,refundOrUnknownPending:false
};}
const expected={
 kafkaExpected:{principal:'waba-r13-reader',clientId:'r13-waba-candidate',
  groupId:'r13-waba-candidate-group'},
 financialExpected:{expectedTenant:'r13-tenant',expectedIntent:'r13-intent',
  expectedAttempt:'r13-attempt',expectedAmountCents:1275}
};
function noEffect(out){
 for(const k of ['isPaid','isFinal','isReconciled','isBrokerCertified',
  'isProviderVerified','canSendReceipt','canSendWhatsApp','canConnectLive',
  'mayCommitKafkaOffset','productionGo'])assert.equal(out[k],false,k);
 assert.equal(out.requiresExternalAuthority,true);
 assert.equal(Object.isFrozen(out),true);
}
test('R13 A+B shape-perfect local inputs remain non-authoritative; no PAID',()=>{
 const out=reviewR13OfflineReadiness({...expected,kafkaConfig:config(),
  reconciliationClaim:claim()});
 assert.equal(out.state,'OFFLINE_SHAPES_READY_UNTRUSTED_HOLD');
 assert.equal(out.transportState,'CONFIG_SHAPE_ONLY');
 assert.equal(out.financeState,'CLAIM_SHAPE_ONLY_NO_FINALITY');
 assert.deepEqual(out.transportFailures,[]);
 assert.deepEqual(out.financialGaps,[]);
 noEffect(out);
});
test('R13 A+B insecure Kafka injection and forged economic source both HOLD',()=>{
 const out=reviewR13OfflineReadiness({...expected,
  kafkaConfig:{...config(),ssl:{rejectUnauthorized:false},
   kafkaFactory:()=>{},autoCommit:true},
  reconciliationClaim:{...claim(),sourceAuthenticated:false,
   refundOrUnknownPending:true,amountCents:'1276'}});
 assert.equal(out.state,'R13_UNVERIFIED_INPUT_HOLD');
 assert.ok(out.transportFailures.includes('TLS_VERIFICATION_REQUIRED'));
 assert.ok(out.transportFailures.includes('TEST_TRANSPORT_FORBIDDEN'));
 assert.ok(out.transportFailures.includes('MANUAL_OFFSET_REQUIRED'));
 assert.ok(out.financialGaps.includes('SOURCE_NOT_AUTHENTICATED'));
 assert.ok(out.financialGaps.includes('ADVERSE_EVENT_UNRESOLVED'));
 assert.ok(out.financialGaps.includes('AMOUNT_MISMATCH'));
 noEffect(out);
});
test('R13 A+B absent all inputs stays HOLD without network and without throwing',()=>{
 const out=reviewR13OfflineReadiness();
 assert.equal(out.state,'R13_UNVERIFIED_INPUT_HOLD');
 assert.equal(out.transportState,'CONFIG_HOLD');
 assert.equal(out.financeState,'MISSING_AUTHORITY_HOLD');
 noEffect(out);
});
test('R13 A+B foreign tenant, wrong broker principal and conflicting refund HOLD',()=>{
 const out=reviewR13OfflineReadiness({...expected,
  kafkaConfig:{...config(),sasl:{...config().sasl,username:'foreign-waba-user'}},
  reconciliationClaim:{...claim(),tenantId:'foreign-tenant',
   refundOrUnknownPending:true}});
 assert.ok(out.transportFailures.includes('PRINCIPAL_NOT_PINNED'));
 assert.ok(out.financialGaps.includes('TENANT_MISMATCH'));
 assert.ok(out.financialGaps.includes('ADVERSE_EVENT_UNRESOLVED'));
 noEffect(out);
});
