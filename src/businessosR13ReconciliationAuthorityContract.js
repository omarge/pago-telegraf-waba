'use strict';
// R13 financial authority boundary. A local Kafka candidate or read-side
// snapshot is not authoritative proof of final capture or settlement.
// This module never performs IO and can NEVER authorize payment receipts.
const EVIDENCE=['tenantId','paymentIntentId','paymentAttemptId','provider',
 'providerTransactionId','captureStatus','currency','amountCents',
 'reconciliationId','sourceRevision'];
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
function reviewR13ReconciliationClaim(claim,{expectedTenant,expectedIntent,
 expectedAttempt,expectedAmountCents,expectedCurrency='MXN'}={}){
 const gaps=[];
 if(!claim||typeof claim!=='object'||Array.isArray(claim))
  return Object.freeze({state:'MISSING_AUTHORITY_HOLD',gaps:['NO_CLAIM'],
   isPaid:false,isFinal:false,canSendReceipt:false,productionGo:false});
 for(const k of EVIDENCE)if(claim[k]===undefined||claim[k]===null||claim[k]==='')
  gaps.push('MISSING_'+k);
 for(const k of ['tenantId','paymentIntentId','paymentAttemptId','provider',
 'providerTransactionId','reconciliationId'])
  if(typeof claim[k]!=='string'||!IDENT.test(claim[k]))
   gaps.push('INVALID_'+k);
 if(expectedTenant&&claim.tenantId!==expectedTenant)gaps.push('TENANT_MISMATCH');
 if(expectedIntent&&claim.paymentIntentId!==expectedIntent)gaps.push('INTENT_MISMATCH');
 if(expectedAttempt&&claim.paymentAttemptId!==expectedAttempt)gaps.push('ATTEMPT_MISMATCH');
 if(claim.currency!==expectedCurrency)gaps.push('CURRENCY_MISMATCH');
 if(typeof claim.amountCents!=='string'||!/^[1-9][0-9]*$/.test(claim.amountCents)||
  !Number.isSafeInteger(Number(claim.amountCents)))gaps.push('INVALID_AMOUNT');
 if(expectedAmountCents!==undefined&&claim.amountCents!==String(expectedAmountCents))
  gaps.push('AMOUNT_MISMATCH');
 if(claim.captureStatus!=='CAPTURED')gaps.push('CAPTURE_NOT_PROVEN');
 if(claim.reconciliationStatus!=='MATCHED')gaps.push('RECONCILIATION_NOT_PROVEN');
 if(claim.sourceRevision===undefined||typeof claim.sourceRevision!=='string'||
  !IDENT.test(claim.sourceRevision))gaps.push('INVALID_SOURCE_REVISION');
 if(claim.providerProofVerified!==true)gaps.push('PROVIDER_PROOF_UNVERIFIED');
 if(claim.sourceAuthenticated!==true)gaps.push('SOURCE_NOT_AUTHENTICATED');
 if(claim.refundOrUnknownPending!==false)gaps.push('ADVERSE_EVENT_UNRESOLVED');
 // Even a self-consistent claim is untrusted without an authenticated,
 // read-side BusinessOS authority (not yet exposed to WABA).
 return Object.freeze({state:gaps.length?'MISSING_AUTHORITY_HOLD':'CLAIM_SHAPE_ONLY_NO_FINALITY',
  gaps:Object.freeze([...new Set(gaps)]),isPaid:false,isFinal:false,
  isProviderVerified:false,isReconciled:false,canSendReceipt:false,
  canSendWhatsApp:false,productionGo:false});
}
module.exports={reviewR13ReconciliationClaim};
