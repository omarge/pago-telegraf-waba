'use strict';
// R10 evidence gate: no Payment API, no PSP and NO financial dispatcher.
// Injected identity, vault, Fraud ports are NOT implemented by a public route.
// No caller-provided tenant/customer/APPROVE may bypass these trusted ports.
const {prepareCanonicalFraudAssessment,
 validateFraudAssessmentResponse}=require('./businessosCanonicalFraud');
const {methodBindingDigest}=require('./businessosMethodBinding');
const ORDER=/^KPR-[A-F0-9]{32}$/;
function createR10CanonicalEvidenceGate({
 enabled=false,loadCanonicalIdentity,loadVaultMethod,
 securityDelegate,assessFraud
}={}){
 if([loadCanonicalIdentity,loadVaultMethod,securityDelegate,assessFraud]
   .some(fn=>typeof fn!=='function'))
  throw Error('R10_TRUSTED_PORTS_REQUIRED');
 async function prepare({request,accountId,device}={}){
  if(enabled!==true)return {state:'DISABLED'};
  if(!request||!ORDER.test(request.id||'')||
     request.state!=='PENDING'||request.payerAccountId!==accountId)
   return {state:'REQUEST_UNVERIFIED'};
  let identity,method,packet;
  try{
   identity=await loadCanonicalIdentity({
    accountId,requestId:request.id
   });
   if(!identity||identity.accountId!==accountId)
    return {state:'IDENTITY_UNVERIFIED'};
   method=await loadVaultMethod({
    accountId,requestId:request.id,
    tenantId:identity.tenantId,customerId:identity.customerId
   });
   packet=prepareCanonicalFraudAssessment({
    request,accountId,identity,method,device
   });
  }catch(_e){return {state:'CANONICAL_MAPPING_UNVERIFIED'};}
  // The R9 delegation comes from Security Engine only; the requested tenant
  // is intent, not authority. No Fraud call until ALLOW is tenant-bound.
  let delegation;
  try{delegation=await securityDelegate({
    trustedTenantId:packet.tenantId
   });}catch(_e){return {state:'SECURITY_ENGINE_UNAVAILABLE'};}
  if(delegation?.state!=='DELEGATED_BOUNDED'||
     delegation.trustedTenantId!==packet.tenantId||
     typeof delegation.delegatedBearer!=='string'||
     delegation.delegatedBearer.length<16)
   return {state:'SECURITY_ENGINE_NOT_AUTHORIZED'};
  let assessment;
  try{
   // The Fraud port must itself authenticate and bind TenantContext; Payment
   // audience delegation cannot be silently reused as Fraud credentials.
   // No delegated bearer is given to the Fraud port by this component.
   assessment=await assessFraud({
    trustedTenantId:packet.tenantId,
    idempotencyKey:packet.idempotencyKey,
    body:packet.fraudRequest
   });
  }catch(_e){return {state:'FRAUD_UNKNOWN_HOLD_NO_AUTO_RETRY'};}
  const verdict=validateFraudAssessmentResponse(assessment,packet.tenantId);
  if(verdict.state!=='FRAUD_APPROVE_CANDIDATE_ONLY')return verdict;
  // Candidate evidence is NOT permission to execute or capture. No status
  // PAID, no events or journal, no bearer exposed to caller or database.
  return {state:'EVIDENCE_CANDIDATE_OFFLINE_ONLY',
   customerId:packet.paymentEvidence.customerId,
   tenantId:packet.paymentEvidence.tenantId,
   assessmentId:verdict.assessmentId,
   requestId:packet.paymentEvidence.requestId,
   // Match the exact method screened by Fraud to the subsequent Payment DTO.
   // Commitment is not a proof of remote origin; the ports remain trusted.
   paymentMethodBindingDigest:methodBindingDigest({
    requestId:packet.paymentEvidence.requestId,
    accountId:packet.paymentEvidence.accountId,
    tenantId:packet.paymentEvidence.tenantId,
    customerId:packet.paymentEvidence.customerId,
    merchantId:packet.paymentEvidence.merchantId,
    providerAccountId:packet.paymentEvidence.providerAccountId,
    amountCents:packet.paymentEvidence.amountCents,
    provider:packet.paymentEvidence.paymentMethodReferenceProvider,
    opaqueReference:packet.paymentEvidence.paymentMethodReference,
    assessmentId:verdict.assessmentId,
    deviceFingerprint:device.fingerprint,deviceIp:device.ip
   })};
 }
 return Object.freeze({prepare,isEnabled:enabled===true,
  isPaymentDispatcher:false});
}
module.exports={createR10CanonicalEvidenceGate};
