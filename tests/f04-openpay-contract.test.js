'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createSandboxProvider}=require('../src/openpayCardProvider');
const requestId='KPR-'+'A'.repeat(32);
function transportFor(response){
 const calls=[];
 return {
  calls,
  request(options,handler){
   const req=new EventEmitter();
   let body='';
   req.write=part=>{body+=String(part);};
   req.end=()=>{
    calls.push({options,body});
    queueMicrotask(()=>{
     const res=new EventEmitter();res.statusCode=200;
     handler(res);res.emit('data',Buffer.from(JSON.stringify(response)));res.emit('end');
    });
   };
   req.destroy=e=>req.emit('error',e);
   return req;
  }
 };
}
function provider(transport){
 return createSandboxProvider({
  enabled:true,merchantId:'merchant_f04_1234',publicKey:'pk_dummy_f04',
  privateKey:'sk_dummy_f04',transport
 });
}
test('F04 sandbox financial POST uses customer-scoped card, exact amount and device ID, fake HTTPS only',async()=>{
 const network=transportFor({id:'charge_f04_123456',status:'completed'});
 const api=provider(network);
 const old=process.env.WABA_SAVED_CARD_PAY_SANDBOX;
 process.env.WABA_SAVED_CARD_PAY_SANDBOX='1';
 try{
  const response=await api.chargeSavedCard({
   customerId:'customer_f04_123456',cardId:'card_f04_123456',amountCents:1000,
   requestId,deviceSessionId:'device_f04_123456'
  });
  assert.equal(response.status,'completed');
  assert.equal(network.calls.length,1);
  const {options,body}=network.calls[0];
  assert.equal(options.hostname,'sandbox-api.openpay.mx');
  assert.equal(options.method,'POST');
  assert.equal(options.path,'/v1/merchant_f04_1234/customers/customer_f04_123456/charges');
  assert.deepEqual(JSON.parse(body),{
   method:'card',source_id:'card_f04_123456',amount:10,currency:'MXN',
   order_id:requestId,description:'KashBitPay WABA saved card Sandbox',
   device_session_id:'device_f04_123456'
  });
 }finally{
  if(old===undefined)delete process.env.WABA_SAVED_CARD_PAY_SANDBOX;
  else process.env.WABA_SAVED_CARD_PAY_SANDBOX=old;
 }
});

test('F04 charge verification GET is customer-scoped with no new POST',async()=>{
 const result={id:'charge_f04_123456',status:'completed',order_id:requestId,
  amount:10,currency:'MXN'};
 const network=transportFor(result);
 const api=provider(network);
 assert.deepEqual(await api.getCharge('customer_f04_123456','charge_f04_123456'),result);
 assert.equal(network.calls.length,1);
 assert.equal(network.calls[0].options.method,'GET');
 assert.equal(network.calls[0].body,'');
 assert.equal(network.calls[0].options.path,
  '/v1/merchant_f04_1234/customers/customer_f04_123456/charges/charge_f04_123456');
});

test('F04 charge remains disabled when runtime opt-in is not enabled',async()=>{
 const network=transportFor({});
 const api=provider(network);
 const old=process.env.WABA_SAVED_CARD_PAY_SANDBOX;
 process.env.WABA_SAVED_CARD_PAY_SANDBOX='0';
 try{
  await assert.rejects(api.chargeSavedCard({
   customerId:'customer_f04_123456',cardId:'card_f04_123456',amountCents:1000,
   requestId,deviceSessionId:'device_f04_123456'
  }),/disabled/);
  assert.equal(network.calls.length,0);
 }finally{
  if(old===undefined)delete process.env.WABA_SAVED_CARD_PAY_SANDBOX;
  else process.env.WABA_SAVED_CARD_PAY_SANDBOX=old;
 }
});
