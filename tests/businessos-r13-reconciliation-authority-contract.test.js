'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewR13ReconciliationClaim}=require('../src/businessosR13ReconciliationAuthorityContract');
const good=()=>({tenantId:'tenant-r13',paymentIntentId:'intent-r13',
 paymentAttemptId:'attempt-r13',provider:'openpay',providerTransactionId:'psp-r13',
 captureStatus:'CAPTURED',currency:'MXN',amountCents:'1275',reconciliationId:'rec-r13',
 sourceRevision:'revision-r13',reconciliationStatus:'MATCHED',
 providerProofVerified:true,sourceAuthenticated:true,refundOrUnknownPending:false});
const expected={expectedTenant:'tenant-r13',expectedIntent:'intent-r13',
 expectedAttempt:'attempt-r13',expectedAmountCents:1275};
test('plausible untrusted claim never releases PAID or a receipt',()=>{
 const r=reviewR13ReconciliationClaim(good(),expected);
 assert.equal(r.state,'CLAIM_SHAPE_ONLY_NO_FINALITY');
 assert.equal(r.isPaid,false);assert.equal(r.canSendReceipt,false);
 assert.equal(r.isReconciled,false);assert.equal(r.productionGo,false);
});
test('adverse economic evidence fails closed',()=>{
 const r=reviewR13ReconciliationClaim({...good(),refundOrUnknownPending:true,
  providerProofVerified:false,paymentIntentId:'wrong-intent',amountCents:'1276'},expected);
 for(const v of ['ADVERSE_EVENT_UNRESOLVED','PROVIDER_PROOF_UNVERIFIED',
 'INTENT_MISMATCH','AMOUNT_MISMATCH'])assert.ok(r.gaps.includes(v));
 assert.equal(r.state,'MISSING_AUTHORITY_HOLD');
});
test('invalid money and missing source cannot produce finality',()=>{
 assert.equal(reviewR13ReconciliationClaim(null).state,'MISSING_AUTHORITY_HOLD');
 const r=reviewR13ReconciliationClaim({...good(),amountCents:'12.75',
  sourceAuthenticated:false},expected);
 assert.ok(r.gaps.includes('INVALID_AMOUNT'));
 assert.ok(r.gaps.includes('SOURCE_NOT_AUTHENTICATED'));
 assert.equal(r.isFinal,false);
});
