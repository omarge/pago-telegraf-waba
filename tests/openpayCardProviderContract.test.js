'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createSandboxProvider}=require('../src/openpayCardProvider');

function transportFor({status=200,response={}}={}){
 const calls=[];
 return {
  calls,
  request(options,handler){
   const req=new EventEmitter();let body='';
   req.write=(chunk)=>{body+=String(chunk);};
   req.end=()=>{
    calls.push({options,body});
    queueMicrotask(()=>{
     const res=new EventEmitter();res.statusCode=status;
     handler(res);res.emit('data',Buffer.from(JSON.stringify(response)));res.emit('end');
    });
   };
   req.destroy=e=>req.emit('error',e);
   return req;
  }
 };
}
const config={enabled:true,merchantId:'merchant_f03_123',
 publicKey:'pk_test_dummy',privateKey:'sk_test_dummy'};

test('F03 contract: create customer is merchant-scoped and uses documented POST payload',async()=>{
 const transport=transportFor({status:201,response:{id:'customer_f03_123456'}});
 const api=createSandboxProvider({...config,transport});
 assert.equal((await api.createCustomer({firstName:'Nombre',lastName:'Apellido',email:'qa@example.test'})).id,'customer_f03_123456');
 assert.equal(transport.calls.length,1);
 const {options,body}=transport.calls[0];
 assert.equal(options.hostname,'sandbox-api.openpay.mx');
 assert.equal(options.method,'POST');
 assert.equal(options.path,'/v1/merchant_f03_123/customers');
 assert.equal(options.headers.Authorization,'Basic '+Buffer.from('sk_test_dummy:').toString('base64'));
 assert.deepEqual(JSON.parse(body),{name:'Nombre',last_name:'Apellido',email:'qa@example.test',requires_account:false});
});

test('F03 contract: token and device session sent only via customer card POST',async()=>{
 const transport=transportFor({status:201,response:{id:'card_f03_123456'}});
 const api=createSandboxProvider({...config,transport});
 await api.addCard('customer_f03_123456','token_f03_12345678','device_f03_12345678');
 assert.equal(transport.calls.length,1);
 assert.equal(transport.calls[0].options.method,'POST');
 assert.equal(transport.calls[0].options.path,'/v1/merchant_f03_123/customers/customer_f03_123456/cards');
 assert.deepEqual(JSON.parse(transport.calls[0].body),{token_id:'token_f03_12345678',device_session_id:'device_f03_12345678'});
});

test('F03 contract: getCard is read-only and scoped to customer',async()=>{
 const card={id:'card_f03_123456',customer_id:'customer_f03_123456',brand:'visa',card_number:'4242',allows_charges:true};
 const transport=transportFor({status:200,response:card});
 const api=createSandboxProvider({...config,transport});
 assert.deepEqual(await api.getCard('customer_f03_123456','card_f03_123456'),card);
 assert.equal(transport.calls[0].options.method,'GET');
 assert.equal(transport.calls[0].body,'');
 assert.equal(transport.calls[0].options.path,'/v1/merchant_f03_123/customers/customer_f03_123456/cards/card_f03_123456');
});

test('F03 contract: HTTP error propagates only safe codes without secrets',async()=>{
 const transport=transportFor({status:422,response:{error_code:1003,description:'sensitive_should_not_leak',request_id:'hidden'}});
 const api=createSandboxProvider({...config,transport});
 await assert.rejects(api.createCustomer({firstName:'Test',lastName:'Test',email:'a@b.c'}),error=>{
  assert.equal(error.message,'Openpay Sandbox rejected request');
  assert.equal(error.openpayHttpStatus,422);
  assert.equal(error.openpayCode,'1003');
  assert.doesNotMatch(JSON.stringify({message:error.message,status:error.openpayHttpStatus,code:error.openpayCode}),/sensitive_should_not_leak|hidden/);
  return true;
 });
});

test('F03 scope: no saved-card charge when payment flag disabled',async()=>{
 const transport=transportFor();
 const api=createSandboxProvider({...config,transport});
 const old=process.env.WABA_SAVED_CARD_PAY_SANDBOX;
 process.env.WABA_SAVED_CARD_PAY_SANDBOX='0';
 try{
  await assert.rejects(api.chargeSavedCard({}),/disabled/);
  assert.equal(transport.calls.length,0);
 }finally{
  if(old===undefined)delete process.env.WABA_SAVED_CARD_PAY_SANDBOX;
  else process.env.WABA_SAVED_CARD_PAY_SANDBOX=old;
 }
});
