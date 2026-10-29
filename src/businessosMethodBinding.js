'use strict';
// Internal, offline-only commitment tying Fraud's assessed vault method to
// Payment's authorization method. This is NOT a remote signature or proof of
// service authenticity; trusted resolvers still require S2S certification.
const crypto=require('node:crypto');
const net=require('node:net');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE=/^[A-Za-z0-9][A-Za-z0-9._:\/=-]{0,255}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER=/^KPR-[A-F0-9]{32}$/;
function methodBindingDigest({
 requestId,accountId,tenantId,customerId,merchantId,providerAccountId,
 amountCents,provider,opaqueReference,assessmentId,deviceFingerprint,deviceIp
}={}){
 const identities=[accountId,tenantId,customerId,merchantId,providerAccountId,
  provider,deviceFingerprint];
 if(!ORDER.test(requestId||'')||identities.some(x=>typeof x!=='string'||!ID.test(x))||
    typeof opaqueReference!=='string'||!OPAQUE.test(opaqueReference)||
    !Number.isSafeInteger(amountCents)||amountCents<=0||
    !UUID.test(assessmentId||'')||!net.isIP(deviceIp||''))
   throw Error('R11_METHOD_BINDING_UNVERIFIED');
 // Ordered array: no ambiguous JSON object property ordering. Never persist
 // the opaque vault reference; only this commitment is stored by R11.
 const tuple=[requestId,accountId,tenantId,customerId,merchantId,
  providerAccountId,amountCents,provider,opaqueReference,
  assessmentId.toLowerCase(),deviceFingerprint,deviceIp];
 return crypto.createHash('sha256')
  .update('waba-r11-method-fraud-binding-v1\n'+JSON.stringify(tuple)).digest('hex');
}
module.exports={methodBindingDigest};
