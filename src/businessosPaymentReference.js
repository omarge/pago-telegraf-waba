'use strict';
// F06 R6. Read-only reference for a FUTURE BusinessOS integration.
// This is not a BusinessOS command, event, payment confirmation authority,
// transport adapter, or outbox. It never sends to a remote service.
const crypto=require('node:crypto');
const REQUEST=/^KPR-[A-F0-9]{32}$/;
const CHARGE=/^[A-Za-z0-9_-]{8,100}$/;
function centsToDecimal(cents){
 if(!Number.isSafeInteger(cents)||cents<=0)
  throw Error('WABA_REFERENCE_INVALID_AMOUNT');
 return Math.trunc(cents/100)+'.'+String(cents%100).padStart(2,'0');
}
function createVerifiedPaymentReference({accountId,requestId,journal,accounts}={}){
 if(typeof accountId!=='string'||!accountId||!REQUEST.test(requestId||'')||
    !journal||typeof journal.receiptForAccount!=='function'||
    !accounts||typeof accounts.getLinkedWhatsApp!=='function')
  throw Error('WABA_REFERENCE_INVALID_INPUT');
 // The verified journal is the sole source. Never trust a client-supplied
 // charge_id, currency, amount or claimed completed status.
 const receipt=journal.receiptForAccount(accountId,requestId,accounts);
 if(!receipt||receipt.direction!=='PAGO')return null;
 if(receipt.requestId!==requestId||!CHARGE.test(receipt.chargeId||'')||
    receipt.currency!=='MXN'||receipt.status!=='completed'||
    receipt.source!=='openpay_saved_card_sandbox')
  throw Error('WABA_REFERENCE_UNVERIFIED');
 const amountDecimal=centsToDecimal(receipt.amountCents);
 // Dedupe hint for a future contract mapping, NOT a BusinessOS idempotency key.
 // BusinessOS requires tenant-scoped CommandMetadata/EventMetadata; WABA has
 // no authorized tenant mapping, producer identity, or canonical transport.
 const digest=crypto.createHash('sha256')
  .update('waba-openpay-sandbox-ref-v1\0'+receipt.requestId+'\0'+receipt.chargeId)
  .digest('hex');
 return Object.freeze({
  kind:'WABA_VERIFIED_OPENPAY_REFERENCE',
  version:1,
  integrationState:'LOCAL_REFERENCE_ONLY',
  sourceSystem:'kashbitpay-waba',
  sourceEnvironment:'openpay_sandbox',
  requestId:receipt.requestId,
  providerChargeId:receipt.chargeId,
  amountDecimal,
  currency:'MXN',
  verifiedProviderStatus:'completed',
  dedupeHint:'waba-ref-v1-'+digest,
  businessosAuthority:'NONE'
 });
}
module.exports={centsToDecimal,createVerifiedPaymentReference};
