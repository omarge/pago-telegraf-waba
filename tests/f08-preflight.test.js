'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assessUat,run}=require('../scripts/f08-uat-readiness');
test('F08 actual current readiness NO_GO: Meta review, test override, unsigned webhook, volatile state',()=>{
 const r=assessUat({env:{WABA_TEST_TO:'525500000000'},
  metaNameStatus:'PENDING_REVIEW',legacyEndpointDisabled:true});
 assert.equal(r.status,'PUBLIC_UAT_NO_GO');
 assert.deepEqual(r.blockers,[
  'BLOCKED_META_NAME_NOT_APPROVED_OR_UNVERIFIED',
  'BLOCKED_TEST_DESTINATION_OVERRIDE',
  'BLOCKED_PUBLIC_WEBHOOK_SIGNATURE_NOT_ENFORCED',
  'BLOCKED_INMEMORY_PAYMENT_REQUESTS',
  'BLOCKED_NO_DEPLOY_APPROVAL'
 ]);
});
test('F08 no approval means NO_GO even with ideal hypothetical security flags',()=>{
 const r=assessUat({env:{},metaNameStatus:'APPROVED',
  incomingWebhookSignatureEnforced:true,paymentRequestsDurable:true,
  legacyEndpointDisabled:true});
 assert.equal(r.status,'PUBLIC_UAT_NO_GO');
 assert.deepEqual(r.blockers,['BLOCKED_NO_DEPLOY_APPROVAL']);
});
test('F08 operator approval alone does not bypass Meta, override or technical gate',()=>{
 const r=assessUat({env:{WABA_TEST_TO:'mock'},operatorApproved:true,
  metaNameStatus:'PENDING_REVIEW',incomingWebhookSignatureEnforced:true,
  paymentRequestsDurable:true,legacyEndpointDisabled:true});
 assert.equal(r.status,'PUBLIC_UAT_NO_GO');
 assert.ok(r.blockers.includes('BLOCKED_META_NAME_NOT_APPROVED_OR_UNVERIFIED'));
 assert.ok(r.blockers.includes('BLOCKED_TEST_DESTINATION_OVERRIDE'));
});
test('F08 read-only output is scrubbed; never includes tokens, WhatsApp or secrets',()=>{
 const logs=[];
 const r=run({env:{WABA_TEST_TO:'525544443333',WABA_TOKEN:'secret-private-value',
  OPENPAY_PRIVATE_KEY:'private-secret-key'},
  log:{log:s=>logs.push(s)}});
 assert.equal(r.status,'PUBLIC_UAT_NO_GO');
 assert.ok(!logs.join('\n').includes('525544443333'));
 assert.ok(!logs.join('\n').includes('secret-private-value'));
 assert.ok(!logs.join('\n').includes('private-secret-key'));
 assert.ok(logs.includes('F08_META_MESSAGES_SENT=0'));
 assert.ok(logs.includes('F08_OPENPAY_CHARGES=0'));
});
test('F08 missing legacy route hardening is a separate blocker',()=>{
 const r=assessUat({env:{},metaNameStatus:'APPROVED',
  incomingWebhookSignatureEnforced:true,paymentRequestsDurable:true,
  legacyEndpointDisabled:false,operatorApproved:true});
 assert.deepEqual(r.blockers,['BLOCKED_LEGACY_CHARGE_ROUTE']);
});
test('F08 hypothetical config precheck never attests real WhatsApp delivery',()=>{
 const r=assessUat({env:{},metaNameStatus:'APPROVED',
  incomingWebhookSignatureEnforced:true,paymentRequestsDurable:true,
  legacyEndpointDisabled:true,operatorApproved:true});
 assert.equal(r.status,'CONFIG_PRECHECK_ONLY');
 assert.equal(r.outboundMessages,0);
 assert.equal(r.providerCharges,0);
});
