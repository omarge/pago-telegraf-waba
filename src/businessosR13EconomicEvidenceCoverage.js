'use strict';
// R13-D: inspect alleged source completeness and revision ordering.
// NOT actual Payment Engine reconciliation, bank/PSP proof or signature check.
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const INT=/^(0|[1-9][0-9]{0,18})$/;
const MAX=9223372036854775807n;
function revision(x){
 if(typeof x!=='string'||!INT.test(x))return null;
 const n=BigInt(x);
 return n<=MAX?n:null;
}
function reviewR13EconomicEvidenceCoverage(evidence={},expected={}){
 const e=evidence&&typeof evidence==='object'&&!Array.isArray(evidence)?evidence:{};
 const problems=[];
 const ids=['tenantId','paymentIntentId','paymentAttemptId',
  'providerTransactionId','reconciliationId'];
 for(const name of ids)if(typeof e[name]!=='string'||!IDENT.test(e[name]))
  problems.push('INVALID_'+name);
 const pins=[
  ['tenantId','tenantId'],['paymentIntentId','paymentIntentId'],
  ['paymentAttemptId','paymentAttemptId']];
 for(const [name,expectedName] of pins)
  if(expected[expectedName]&&e[name]!==expected[expectedName])
   problems.push('MISMATCH_'+name);
 if(e.currency!=='MXN')problems.push('CURRENCY_MISMATCH');
 if(typeof e.amountCents!=='string'||! /^[1-9][0-9]*$/.test(e.amountCents)||
    !Number.isSafeInteger(Number(e.amountCents)))
  problems.push('INVALID_MONEY');
 if(expected.amountCents!==undefined&&
    String(expected.amountCents)!==e.amountCents)
  problems.push('AMOUNT_MISMATCH');
 const finality=revision(e.captureRevision);
 const watermark=revision(e.authoritativeWatermark);
 const refundWatermark=revision(e.adverseEventsWatermark);
 if(finality===null||watermark===null||refundWatermark===null)
  problems.push('REVISION_MISSING_OR_INVALID');
 else{
  if(finality>watermark)problems.push('CAPTURE_AFTER_SOURCE_WATERMARK');
  if(refundWatermark<finality||refundWatermark<watermark)
   problems.push('ADVERSE_EVENTS_COVERAGE_LAG');
 }
 if(e.providerCaptureEvidenceId===undefined||!IDENT.test(e.providerCaptureEvidenceId))
  problems.push('CAPTURE_PROVIDER_EVIDENCE_MISSING');
 if(e.captureResult!=='CAPTURED')problems.push('CAPTURE_NOT_ESTABLISHED');
 if(e.reconciliationResult!=='MATCHED')problems.push('RECONCILIATION_NOT_ESTABLISHED');
 if(e.unknownCount!==0||e.pendingRefundCount!==0||e.pendingDisputeCount!==0)
  problems.push('ADVERSE_EVENT_UNRESOLVED');
 if(e.sourceProducer!=='payment-engine')problems.push('NOT_PAYMENT_ENGINE_SOURCE');
 if(e.authenticatedSnapshot!==true)
  problems.push('SNAPSHOT_AUTHENTICATION_UNVERIFIED');
 if(typeof e.uatEvidenceRunId!=='string'||!IDENT.test(e.uatEvidenceRunId))
  problems.push('UAT_EVIDENCE_ID_MISSING');
 return Object.freeze({
  state:problems.length?'ECONOMIC_COVERAGE_GAPS_HOLD':'SELF_REPORTED_COVERAGE_HOLD',
  problems:Object.freeze([...new Set(problems)]),
  isFinal:false,isPaid:false,isReconciled:false,
  isProviderVerified:false,canSendReceipt:false,canSendWhatsApp:false,
  productionGo:false,requiresAuthenticatedReadModel:true
 });
}
module.exports={reviewR13EconomicEvidenceCoverage};
