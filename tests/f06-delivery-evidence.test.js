'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createDeliveryEvidence,verifySignature,normalizeRecipient}=require('../src/f06DeliveryEvidence');

const secret='offline-only-Meta-App-Secret-F06-test';
const phoneId='1478834131971433';
const payer='5215512345678',collector='5215543964378';
const payerId='wamid.payer.F06_mock_0123',collectorId='wamid.collector.F06_mock_0456';
function audit(opts={}){return createDeliveryEvidence({appSecret:secret,phoneId,...opts});}
function accepted(a,role,id,to){
 return a.recordAcceptance({role,recipient:to,metaResponse:{messages:[{id}]}});
}
function payload(events,{sender=phoneId,field='messages'}={}){
 return Buffer.from(JSON.stringify({
  object:'whatsapp_business_account',entry:[{changes:[{
   field,value:{messaging_product:'whatsapp',
    metadata:{phone_number_id:sender},statuses:events}
  }]}]
 }));
}
function status(id,kind,to,stamp='1780000000',code){
 return {id,status:kind,recipient_id:to,timestamp:stamp,
  ...(code?{errors:[{code,title:'do not expose sensitive failure details'}]}:{})};
}
function ingest(a,events,opts={}){
 const body=payload(events,opts);
 const signature='sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex');
 return a.ingestSignedStatus({rawBody:body,signature});
}
test('F06 no Meta 2xx message ID means no acceptance and never delivered',()=>{
 const a=audit();
 assert.throws(()=>accepted(a,'PAYER','badId',payer),/F06_ACCEPTANCE_INVALID/);
 assert.throws(()=>a.recordAcceptance({role:'PAYER',recipient:payer,
  metaResponse:{error:{code:131037}}}),/F06_ACCEPTANCE_INVALID/);
 assert.equal(a.summary().tracked,0);
 assert.equal(a.summary().evidenceBilateralDelivered,false);
});
test('F06 Meta 2xx acceptance is not sent, delivered or read',()=>{
 const a=audit();
 assert.deepEqual(accepted(a,'PAYER',payerId,payer),{state:'ACCEPTED_BY_META',duplicate:false});
 assert.equal(a.summary().states.ACCEPTED_BY_META,1);
 assert.equal(a.summary().states.delivered,0);
 assert.equal(a.summary().evidenceBilateralDelivered,false);
 assert.equal(a.summary().isLiveIntegrated,false);
});
test('F06 valid signature required for status mutation; wrong signatures rejected',()=>{
 const a=audit();accepted(a,'PAYER',payerId,payer);
 const p=payload([status(payerId,'delivered',normalizeRecipient(payer))]);
 assert.equal(verifySignature(p,'sha256='+crypto.createHmac('sha256',secret).update(p).digest('hex'),secret),true);
 for(const invalid of ['', 'sha256='+('0'.repeat(64)), 'sha256=not-hex']){
  assert.throws(()=>a.ingestSignedStatus({rawBody:p,signature:invalid}),/F06_WEBHOOK_UNVERIFIED/);
 }
 assert.equal(a.summary().states.ACCEPTED_BY_META,1);
});
test('F06 state progression and duplicate/reordered callbacks are monotonic and deduplicated',()=>{
 const a=audit();accepted(a,'PAYER',payerId,payer);
 const to=normalizeRecipient(payer);
 assert.equal(ingest(a,[status(payerId,'read',to)]).updated,1);
 assert.equal(ingest(a,[status(payerId,'sent',to)]).ignored,1);
 assert.equal(ingest(a,[status(payerId,'delivered',to)]).ignored,1);
 assert.equal(ingest(a,[status(payerId,'read',to)]).duplicate,1);
 assert.equal(a.summary().states.read,1);
});
test('F06 failed callback marks failure without leaking title/details and never becomes delivered',()=>{
 const a=audit();accepted(a,'PAYER',payerId,payer);
 const to=normalizeRecipient(payer);
 ingest(a,[status(payerId,'sent',to)]);
 assert.equal(ingest(a,[status(payerId,'failed',to,'1780000002',131047)].updated,1);
 assert.equal(a.summary().states.failed,1);
 assert.equal(ingest(a,[status(payerId,'delivered',to)]).conflict,1);
 assert.equal(a.summary().evidenceBilateralDelivered,false);
 assert.ok(!JSON.stringify(a.summary()).includes('do not expose'));
});
test('F06 observed delivery remains visible if a contradictory later failed webhook arrives',()=>{
 const a=audit();accepted(a,'PAYER',payerId,payer);
 ingest(a,[status(payerId,'delivered',normalizeRecipient(payer))]);
 assert.equal(ingest(a,[status(payerId,'failed',normalizeRecipient(payer))]).conflict,1);
 assert.equal(a.summary().states.delivered,1);
});
test('F06 mismatched recipient, sender phone ID, unknown wamid and status are ignored',()=>{
 const a=audit();accepted(a,'PAYER',payerId,payer);
 assert.equal(ingest(a,[status(payerId,'delivered',normalizeRecipient(collector))]).ignored,1);
 assert.equal(ingest(a,[status(payerId,'delivered',normalizeRecipient(payer))],{sender:'OTHER_PHONE'}).ignored,1);
 assert.equal(ingest(a,[status('wamid.unknown.00000','delivered',normalizeRecipient(payer))]).ignored,1);
 assert.equal(ingest(a,[status(payerId,'unknown',normalizeRecipient(payer))]).ignored,1);
 assert.equal(a.summary().states.ACCEPTED_BY_META,1);
});
test('F06 bilateral audit requires two distinct recipients and correct roles',()=>{
 const a=audit();
 accepted(a,'PAYER',payerId,payer);
 accepted(a,'COLLECTOR',collectorId,collector);
 ingest(a,[status(payerId,'delivered',normalizeRecipient(payer))]);
 assert.equal(a.summary().evidenceBilateralDelivered,false);
 ingest(a,[status(collectorId,'read',normalizeRecipient(collector))]);
 assert.equal(a.summary().evidenceBilateralDelivered,true);
 assert.deepEqual(a.summary().roles,{COLLECTOR:'DELIVERED_OR_READ',PAYER:'DELIVERED_OR_READ'});
});
test('F06 WABA_TEST_TO override blocks evidence registration even for different accounts',()=>{
 const a=audit({testToOverride:'525555555555'});
 assert.throws(()=>accepted(a,'PAYER',payerId,payer),/F06_TEST_TO_OVERRIDE_ACTIVE/);
 assert.equal(a.summary().tracked,0);
});
test('F06 duplicate Meta accepted ID cannot silently switch owner or destination',()=>{
 const a=audit();accepted(a,'PAYER',payerId,payer);
 assert.equal(accepted(a,'PAYER',payerId,payer).duplicate,true);
 assert.throws(()=>accepted(a,'COLLECTOR',payerId,collector),/F06_ACCEPTANCE_CONFLICT/);
 assert.throws(()=>accepted(a,'PAYER',payerId,collector),/F06_ACCEPTANCE_CONFLICT/);
});
test('F06 bad raw JSON, spoofed envelope, malformed or oversized body fail closed',()=>{
 const a=audit();
 const sign=x=>'sha256='+crypto.createHmac('sha256',secret).update(x).digest('hex');
 for(const body of [Buffer.from('{'),Buffer.from(JSON.stringify({object:'other',entry:[]}))]){
  assert.throws(()=>a.ingestSignedStatus({rawBody:body,signature:sign(body)}),
   /F06_WEBHOOK_INVALID_JSON|F06_WEBHOOK_INVALID_ENVELOPE/);
 }
 const huge=Buffer.alloc(65537);
 assert.throws(()=>a.ingestSignedStatus({rawBody:huge,signature:sign(huge)}),/F06_WEBHOOK_INVALID_BODY/);
});
test('F06 bounded evidence store fails closed and never stores incoming messages automatically',()=>{
 const a=audit({maxRecords:1});
 accepted(a,'PAYER',payerId,payer);
 assert.throws(()=>accepted(a,'COLLECTOR',collectorId,collector),/F06_EVIDENCE_CAPACITY/);
 assert.equal(a.summary().tracked,1);
});
test('F06 status-only webhook on existing live handler does not trigger outbound WhatsApp',async()=>{
 const {createWebhook}=require('../src/webhook');
 const messages=[];
 const svc=createWebhook({
  messenger:{async sendMessage(...args){messages.push(args);}},
  log:{log(){},error(){throw Error('unexpected');}},
  store:{conv:new Map()},
  accounts:{bindFromWhatsApp(){throw Error('unexpected linking');}}
 });
 await svc.handleWebhook(JSON.parse(payload([status(payerId,'delivered',normalizeRecipient(payer))])));
 assert.equal(messages.length,0);
});
