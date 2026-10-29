'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assessR12AuthorityPrerequisites}=require('./reconciliation-authority-preflight');
const expected={tenantId:'tenant-r12i',paymentIntentId:'intent-r12i',
 paymentAttemptId:'attempt-r12i',amountCents:1275,currency:'MXN'};
function candidate(){
 return {
  source:'businessos-payment-engine-authoritative-read',
  ...expected,captureState:'CAPTURED',refundState:'NONE',
  unknownState:'NONE',sourceWatermark:'watermark-r12i',
  providerEvidenceSha256:'a'.repeat(64),
  reconciliationEvidenceSha256:'b'.repeat(64),
  responseBoundToWabaRequest:true,sourceAuthenticationVerified:true,
  responseFreshnessVerified:true,completenessVerified:true
 };
}
function noGo(result){
 for(const key of ['isPaid','isFinal','isReconciled',
  'canSendReceipt','canSendWhatsApp','productionGo','realEndpointIntegrated'])
  assert.equal(result[key],false,key);
}
test('R12-I missing authoritative endpoint evidence -> HOLD without PAID',()=>{
 const r=assessR12AuthorityPrerequisites();
 assert.equal(r.state,'AUTHORITY_ENDPOINT_NOT_AVAILABLE_HOLD');
 noGo(r);
});
test('R12-I cross-tenant, attempt, intent, money all fail closed',()=>{
 for(const patch of [
  {tenantId:'foreign-tenant'}, {paymentIntentId:'foreign-intent'},
  {paymentAttemptId:'foreign-attempt'},{amountCents:1276},
  {currency:'USD'}
 ]){
  const r=assessR12AuthorityPrerequisites({...candidate(),...patch},expected);
  assert.equal(r.state,'AUTHORITY_IDENTITY_OR_MONEY_MISMATCH_HOLD');
  noGo(r);
 }
});
test('R12-I refund, unknown and failed capture never prove economic finality',()=>{
 for(const patch of [
  {captureState:'AUTHORIZED'}, {refundState:'REFUNDED'},
  {unknownState:'UNKNOWN'}, {unknownState:'RESOLVED'},
  {captureState:'FAILED'}
 ]){
  const r=assessR12AuthorityPrerequisites({...candidate(),...patch},expected);
  assert.equal(r.state,'CAPTURE_OR_REVERSAL_UNRESOLVED_HOLD');
  noGo(r);
 }
});
test('R12-I provider digest and completeness watermark are mandatory prerequisites',()=>{
 for(const patch of [
  {providerEvidenceSha256:'not-a-digest'},
  {reconciliationEvidenceSha256:''},{sourceWatermark:''}
 ]){
  const r=assessR12AuthorityPrerequisites({...candidate(),...patch},expected);
  assert.equal(r.state,'PROVIDER_RECONCILIATION_AND_WATERMARK_GAP_HOLD');
  noGo(r);
 }
});
test('R12-I unverifiable authentication/completeness claims never release receipt',()=>{
 for(const field of ['responseBoundToWabaRequest','sourceAuthenticationVerified',
  'responseFreshnessVerified','completenessVerified']){
  const r=assessR12AuthorityPrerequisites({...candidate(),[field]:false},expected);
  assert.equal(r.state,'AUTHORITY_VERIFICATION_INCOMPLETE_HOLD');
  noGo(r);
 }
});
test('R12-I even a fabricated all-green record can NEVER declare PAID',()=>{
 const r=assessR12AuthorityPrerequisites(candidate(),expected);
 assert.equal(r.state,'INDEPENDENT_PAYMENT_AUTHORITY_INTEGRATION_REQUIRED_HOLD');
 noGo(r);
});
test('R12-I rejects unexpected credential fields without echoing inputs',()=>{
 const r=assessR12AuthorityPrerequisites({...candidate(),token:'SECRET_SHOULD_NOT_LOG'},expected);
 assert.equal(r.state,'UNRECOGNIZED_AUTHORITY_DATA_HOLD');
 assert.ok(!JSON.stringify(r).includes('SECRET_SHOULD_NOT_LOG'));
 noGo(r);
});
