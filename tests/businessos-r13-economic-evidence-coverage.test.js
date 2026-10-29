'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewR13EconomicEvidenceCoverage}=
 require('../src/businessosR13EconomicEvidenceCoverage');
function fixture(){return {
 tenantId:'tenant-r13d',paymentIntentId:'intent-r13d',
 paymentAttemptId:'attempt-r13d',providerTransactionId:'provider-r13d',
 reconciliationId:'recon-r13d',currency:'MXN',amountCents:'1275',
 captureRevision:'80',authoritativeWatermark:'82',adverseEventsWatermark:'82',
 providerCaptureEvidenceId:'proof-r13d',captureResult:'CAPTURED',
 reconciliationResult:'MATCHED',unknownCount:0,pendingRefundCount:0,
 pendingDisputeCount:0,sourceProducer:'payment-engine',
 authenticatedSnapshot:true,uatEvidenceRunId:'r13d-offline'
};}
const pins={tenantId:'tenant-r13d',paymentIntentId:'intent-r13d',
 paymentAttemptId:'attempt-r13d',amountCents:1275};
test('R13-D even complete claimed causal evidence is NOT authoritative PAID',()=>{
 const r=reviewR13EconomicEvidenceCoverage(fixture(),pins);
 assert.deepEqual(r.problems,[]);
 assert.equal(r.state,'SELF_REPORTED_COVERAGE_HOLD');
 for(const k of ['isPaid','isFinal','isReconciled','isProviderVerified',
  'canSendReceipt','canSendWhatsApp','productionGo'])assert.equal(r[k],false,k);
 assert.equal(r.requiresAuthenticatedReadModel,true);
});
test('R13-D capture newer than watermark, and missing adverse coverage both HOLD',()=>{
 const x={...fixture(),captureRevision:'93',authoritativeWatermark:'82',
 adverseEventsWatermark:'79'};
 const r=reviewR13EconomicEvidenceCoverage(x,pins);
 assert.ok(r.problems.includes('CAPTURE_AFTER_SOURCE_WATERMARK'));
 assert.ok(r.problems.includes('ADVERSE_EVENTS_COVERAGE_LAG'));
 assert.equal(r.state,'ECONOMIC_COVERAGE_GAPS_HOLD');
});
test('R13-D refund, dispute and unknown unclosed prohibit finality',()=>{
 const r=reviewR13EconomicEvidenceCoverage({...fixture(),
  unknownCount:1,pendingRefundCount:1,pendingDisputeCount:1,
  authenticatedSnapshot:false},pins);
 assert.ok(r.problems.includes('ADVERSE_EVENT_UNRESOLVED'));
 assert.ok(r.problems.includes('SNAPSHOT_AUTHENTICATION_UNVERIFIED'));
 assert.equal(r.canSendReceipt,false);
});
test('R13-D exact MXN cents and tenant identity enforced, BigInt-safe revisions',()=>{
 const bad=reviewR13EconomicEvidenceCoverage({...fixture(),
  tenantId:'foreign-tenant',amountCents:'12.75',
  captureRevision:'9223372036854775808'},pins);
 for(const k of ['MISMATCH_tenantId','INVALID_MONEY','AMOUNT_MISMATCH',
  'REVISION_MISSING_OR_INVALID'])assert.ok(bad.problems.includes(k),k);
 assert.equal(bad.state,'ECONOMIC_COVERAGE_GAPS_HOLD');
 const none=reviewR13EconomicEvidenceCoverage(null,pins);
 assert.equal(none.isPaid,false);
 assert.equal(none.state,'ECONOMIC_COVERAGE_GAPS_HOLD');
});
