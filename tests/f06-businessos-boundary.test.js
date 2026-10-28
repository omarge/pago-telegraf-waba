'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAccountService}=require('../src/accountService');
const {createStatementJournal}=require('../src/statementJournal');
const {createVerifiedPaymentReference,centsToDecimal}=require('../src/businessosPaymentReference');
const REQUEST='KPR-'+'A'.repeat(32);
const CHARGE='charge12345678';
function fixture(amountCents=1000){
 const accounts=createAccountService({filePath:null});
 const payer=accounts.register('f06payer@example.com','payer-secret-123456789');
 const collector=accounts.register('f06collector@example.com','collector-secret-123456');
 const outsider=accounts.register('f06outsider@example.com','outsider-secret-123456');
 const payerId=accounts.getSession(payer.token).accountId;
 const collectorId=accounts.getSession(collector.token).accountId;
 const outsiderId=accounts.getSession(outsider.token).accountId;
 const bind=(session,wa)=>{
  const code=accounts.beginLink(session.token,session.csrf).code;
  assert.equal(accounts.bindFromWhatsApp(wa,code),true);
 };
 bind(payer,'5215555550001');
 bind(collector,'5215555550002');
 const journal=createStatementJournal({filePath:null});
 journal.recordCompleted({
  requestId:REQUEST,chargeId:CHARGE,amountCents,
  payerAccountId:payerId,requesterWaId:'5215555550002'
 });
 return {accounts,journal,payerId,collectorId,outsiderId};
}
test('R6 happy path creates a read-only candidate only from the payer verified F05 journal',()=>{
 const f=fixture();
 const candidate=createVerifiedPaymentReference({
  accountId:f.payerId,requestId:REQUEST,journal:f.journal,accounts:f.accounts
 });
 assert.equal(candidate.kind,'WABA_VERIFIED_OPENPAY_REFERENCE');
 assert.equal(candidate.version,1);
 assert.equal(candidate.amountDecimal,'10.00');
 assert.equal(candidate.currency,'MXN');
 assert.equal(candidate.verifiedProviderStatus,'completed');
 assert.equal(candidate.sourceEnvironment,'openpay_sandbox');
 assert.equal(candidate.providerChargeId,CHARGE);
 assert.equal(candidate.integrationState,'LOCAL_REFERENCE_ONLY');
 assert.equal(candidate.businessosAuthority,'NONE');
 assert.ok(Object.isFrozen(candidate));
});
test('R6 cannot expose or assert payment on behalf of collector or unrelated user',()=>{
 const f=fixture();
 for(const accountId of [f.collectorId,f.outsiderId]){
  assert.equal(createVerifiedPaymentReference({
   accountId,requestId:REQUEST,journal:f.journal,accounts:f.accounts
  }),null);
 }
});
test('R6 stable deterministic dedupe hint, no duplicate or POST/outbox effect',()=>{
 const f=fixture(),args={
  accountId:f.payerId,requestId:REQUEST,journal:f.journal,accounts:f.accounts
 };
 const first=createVerifiedPaymentReference(args);
 const second=createVerifiedPaymentReference(args);
 assert.deepEqual(first,second);
 assert.match(first.dedupeHint,/^waba-ref-v1-[0-9a-f]{64}$/);
 assert.equal(f.journal.listForAccount(f.payerId,f.accounts).length,1);
});
test('R6 exact decimal MXN amount never uses JavaScript floating-point conversion',()=>{
 assert.equal(centsToDecimal(101),'1.01');
 assert.equal(centsToDecimal(1001),'10.01');
 assert.equal(centsToDecimal(Number.MAX_SAFE_INTEGER),'90071992547409.91');
 for(const n of [-1,0,1.1,NaN,Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>centsToDecimal(n),/INVALID_AMOUNT/);
 }
 const f=fixture(101);
 const r=createVerifiedPaymentReference({
  accountId:f.payerId,requestId:REQUEST,journal:f.journal,accounts:f.accounts
 });
 assert.equal(r.amountDecimal,'1.01');
});
test('R6 cannot create canonical BusinessOS payment events or commands without tenant mapping',()=>{
 const f=fixture();
 const result=createVerifiedPaymentReference({
  accountId:f.payerId,requestId:REQUEST,journal:f.journal,accounts:f.accounts
 });
 const obj=JSON.stringify(result);
 for(const unsupported of ['tenantId','tenant_id','eventId','event_id',
  'PaymentCaptured','AuthorizePayment','CapturePayment','idempotency_key',
  'balance','merchantId','merchant_id','payerWaId','cardId','pin','token']){
  assert.equal(obj.includes('"'+unsupported+'"'),false);
 }
 assert.equal(typeof result.send,'undefined');
 assert.equal(typeof result.dispatch,'undefined');
});
test('R6 invalid source data and non-completed status fail closed',()=>{
 const accounts={getLinkedWhatsApp:()=>null};
 const base={requestId:REQUEST,chargeId:CHARGE,amountCents:1000,
  currency:'MXN',status:'completed',source:'openpay_saved_card_sandbox',
  direction:'PAGO'};
 for(const tamper of [
  {currency:'USD'},{status:'pending'},{source:'openpay_unverified'},
  {chargeId:'missing'},{requestId:'KPR-'+('B'.repeat(32))},
  {amountCents:0}
 ]){
  const journal={receiptForAccount:()=>({...base,...tamper})};
  assert.throws(()=>createVerifiedPaymentReference({
   accountId:'payer-01',requestId:REQUEST,journal,accounts
  }),/WABA_REFERENCE_/);
 }
});
test('R6 request not found has no BusinessOS reference and never initiates a charge',()=>{
 const f=fixture();
 const another='KPR-'+'B'.repeat(32);
 assert.equal(createVerifiedPaymentReference({
  accountId:f.payerId,requestId:another,journal:f.journal,accounts:f.accounts
 }),null);
 assert.equal(f.journal.listForAccount(f.payerId,f.accounts).length,1);
});
test('R6 malicious external amount or charge parameters are ignored (journal authority)',()=>{
 const f=fixture();
 const result=createVerifiedPaymentReference({
  accountId:f.payerId,requestId:REQUEST,journal:f.journal,accounts:f.accounts,
  amountCents:999999,chargeId:'fake-charge',status:'completed'
 });
 assert.equal(result.amountDecimal,'10.00');
 assert.equal(result.providerChargeId,CHARGE);
});
