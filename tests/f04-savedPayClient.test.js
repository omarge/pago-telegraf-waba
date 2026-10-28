'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {show}=require('../src/savedCardRoutes');

const script=fs.readFileSync(path.join(__dirname,'../src/savedPayClient.js'),'utf8');
function browser(device,opts={}){
 let submit;
 const form={dataset:{mid:'merchant_dummy_123',pk:'pk_dummy_123'},
  addEventListener(_type,callback){submit=callback;}};
 const button={disabled:true};
 const status={textContent:''};
 const hidden={value:''};
 const node={document:{
  getElementById(name){return ({
   'saved-payment':form,confirm:button,'device-status':status,
   'device-id':opts.missingHidden?null:hidden
  })[name];}
 },window:{OpenPay:null}};
 const openpay={
  setId(id){assert.equal(id,'merchant_dummy_123');},
  setApiKey(key){assert.equal(key,'pk_dummy_123');},
  setSandboxMode(value){assert.equal(value,true);},
  deviceData:{setup(formId,generatedId){
   assert.equal(formId,'saved-payment');
   assert.equal(generatedId,'openpay-device-session');
   return device;
  }}
 };
 node.window.OpenPay=openpay;node.OpenPay=openpay;
 vm.runInNewContext(script,node);
 return {form,button,status,hidden,submit};
}
test('F04 saved-card form: writes Openpay.js returned device session to submitted field',()=>{
 const b=browser('device_openpay_f04_123456');
 assert.equal(b.hidden.value,'device_openpay_f04_123456');
 assert.equal(b.button.disabled,false);
 assert.match(b.status.textContent,/Listo para confirmar/);
 b.submit();
 assert.equal(b.button.disabled,true);
 assert.match(b.status.textContent,/Procesando pago/);
});

test('F04 form fails closed if device is absent, malformed or destination field missing',()=>{
 for(const device of [null,'','bad space','short']){
  const b=browser(device);
  assert.equal(b.button.disabled,true);
  assert.equal(b.hidden.value,'');
  assert.doesNotMatch(b.status.textContent,/Listo para confirmar/);
 }
 const b=browser('device_openpay_f04_123456',{missingHidden:true});
 assert.equal(b.button.disabled,true);
});

test('F04 form renders saved card choice, PIN, consent and amount without secret inputs',()=>{
 const html=show({
  requestId:'KPR-'+'A'.repeat(32),amountCents:1000,state:'PENDING',enabled:true,
  pinConfigured:true,cards:[{id:'card_dummy_123456',brand:'mastercard',last4:'4444'}]
 },'csrf_test_fake','merchant_dummy_123','pk_dummy_123');
 assert.match(html,/mastercard •••• 4444/);
 assert.match(html,/NIP KashBitPay/);
 assert.match(html,/name="deviceSessionId"/);
 assert.match(html,/Autorizo pagar \$10\.00 MXN/);
 assert.match(html,/Openpay Sandbox/);
 assert.doesNotMatch(html,/4111111111111111|secret_private_key/);
});
