'use strict';
// R12-I: proposal for an AUTHENTICATED authoritative Payment Engine read contract.
// It does not call Payment Engine and cannot verify a signed response.
// No hypothetical or self-reported evidence ever authorizes PAID or a receipt.
const HEX=/^[a-f0-9]{64}$/;
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELDS=new Set([
 'source','tenantId','paymentIntentId','paymentAttemptId','currency',
 'amountCents','captureState','refundState','unknownState',
 'sourceWatermark','providerEvidenceSha256','reconciliationEvidenceSha256',
 'responseBoundToWabaRequest','sourceAuthenticationVerified',
 'responseFreshnessVerified','completenessVerified'
]);
const VERIFIED='VERIFIED';
function assessR12AuthorityPrerequisites(input,expected){
 const hold=(reason)=>Object.freeze({state:reason,
  isPaid:false,isFinal:false,isReconciled:false,canSendReceipt:false,
  canSendWhatsApp:false,productionGo:false,realEndpointIntegrated:false});
 if(!input||!expected||typeof input!=='object'||typeof expected!=='object'||
   Array.isArray(input)||Array.isArray(expected))
  return hold('AUTHORITY_ENDPOINT_NOT_AVAILABLE_HOLD');
 if(Object.keys(input).some(k=>!FIELDS.has(k)))return hold('UNRECOGNIZED_AUTHORITY_DATA_HOLD');
 const validExpected=IDENT.test(expected.tenantId||'')&&
  IDENT.test(expected.paymentIntentId||'')&&
  IDENT.test(expected.paymentAttemptId||'')&&
  Number.isSafeInteger(expected.amountCents)&&expected.amountCents>0&&
  expected.currency==='MXN';
 if(!validExpected||input.source!=='businessos-payment-engine-authoritative-read'||
  input.tenantId!==expected.tenantId||
  input.paymentIntentId!==expected.paymentIntentId||
  input.paymentAttemptId!==expected.paymentAttemptId||
  input.currency!==expected.currency||input.amountCents!==expected.amountCents)
  return hold('AUTHORITY_IDENTITY_OR_MONEY_MISMATCH_HOLD');
 if(input.captureState!=='CAPTURED'||input.refundState!=='NONE'||
  input.unknownState!=='NONE')
  return hold('CAPTURE_OR_REVERSAL_UNRESOLVED_HOLD');
 if(!HEX.test(input.providerEvidenceSha256||'')||
    !HEX.test(input.reconciliationEvidenceSha256||'')||
    typeof input.sourceWatermark!=='string'||input.sourceWatermark.length===0||
    input.sourceWatermark.length>128)
  return hold('PROVIDER_RECONCILIATION_AND_WATERMARK_GAP_HOLD');
 if(input.responseBoundToWabaRequest!==true||
    input.sourceAuthenticationVerified!==true||
    input.responseFreshnessVerified!==true||
    input.completenessVerified!==true)
  return hold('AUTHORITY_VERIFICATION_INCOMPLETE_HOLD');
 // All booleans and hashes above are CALLER SUPPLIED, not verified here!
 // No HTTP endpoint or cryptographic signature verifier is implemented.
 return hold('INDEPENDENT_PAYMENT_AUTHORITY_INTEGRATION_REQUIRED_HOLD');
}
module.exports={assessR12AuthorityPrerequisites};
