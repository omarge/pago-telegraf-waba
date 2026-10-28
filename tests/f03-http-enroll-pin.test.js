'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const {createAccountService}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createVault}=require('../src/cardVault');

test('F03 HTTP real + Openpay fake: enroll, masked card, PIN, persistence and no charge',async()=>{
 const calls=[];
 const provider={
  merchantId:'sandboxMerchant001',publicKey:'pk_sandbox_placeholder',
  async createCustomer(p){calls.push('CUSTOMER');assert.equal(p.email,'f03payer@example.com');return {id:'customer_f03_123456'};},
  async addCard(cid,tok,device){
   calls.push('ADD_CARD');
   assert.equal(cid,'customer_f03_123456');
   assert.equal(tok,'token_f03_123456789');assert.equal(device,'device_f03_12345678');
   return {id:'card_f03_12345678'};
  },
  async getCard(cid,id){
   calls.push('GET_CARD');
   return {id,customer_id:cid,brand:'visa',card_number:'4242',allows_charges:true};
  },
  async chargeSavedCard(){assert.fail('F03: no charges permitted');}
 };
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'f03-http-'));
 const file=path.join(temp,'vault.json'),pepper='f03-test-pepper-not-a-live-secret-012345678901';
 const accounts=createAccountService({filePath:null}),password='test-password-f03-123456789';
 const payer=accounts.register('f03payer@example.com',password);
 const other=accounts.register('f03other@example.com','other-password-123456789');
 const id=accounts.getSession(payer.token).accountId;
 const vault=createVault({filePath:file,provider,pepper}),app=express();
 app.use('/pay/app',createAccountRouter({service:accounts,vault,savedCardEnabled:false}));
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));});
 const root='http://127.0.0.1:'+server.address().port;
 const cookie='kashbit_web_session='+payer.token,otherCookie='kashbit_web_session='+other.token;
 const req=(route,options={})=>fetch(root+route,{redirect:'manual',...options});
 try{
  let r=await req('/pay/app/enroll',{headers:{cookie}});
  assert.equal(r.status,200);let page=await r.text();
  assert.match(page,/Guardar tarjeta · Sandbox/);
  assert.match(page,/js\.openpay\.mx/);assert.match(page,/Autorizo guardar/);
  r=await req('/pay/app/assets/enroll.js',{headers:{cookie}});
  assert.equal(r.status,200);page=await r.text();
  assert.match(page,/OpenPay\.token\.create/);assert.match(page,/OpenPay\.deviceData\.setup/);
  r=await req('/pay/app/api/cards/enroll',{method:'POST',
   headers:{cookie,'Content-Type':'application/json','X-CSRF-Token':payer.csrf},
   body:JSON.stringify({tokenId:'token_f03_123456789',deviceSessionId:'device_f03_12345678',
    firstName:'F03',lastName:'Sandbox',consent:true})});
  assert.equal(r.status,201);
  assert.deepEqual(await r.json(),{id:'card_f03_12345678',brand:'visa',last4:'4242'});
  assert.deepEqual(calls,['CUSTOMER','ADD_CARD','GET_CARD']);
  r=await req('/pay/app/cards',{headers:{cookie}});
  assert.equal(r.status,200);page=await r.text();
  assert.match(page,/4242/);assert.doesNotMatch(page,/token_f03/);
  r=await req('/pay/app/api/cards',{headers:{cookie}});
  assert.equal(r.status,200);const cards=await r.json();
  assert.equal(cards.cards.length,1);assert.equal(cards.pinConfigured,false);assert.equal(cards.pinEnabled,true);
  r=await req('/pay/app/pin',{headers:{cookie}});
  assert.equal(r.status,200);assert.match(await r.text(),/Crear NIP/);
  r=await req('/pay/app/pin',{method:'POST',headers:{cookie},
   body:new URLSearchParams({_csrf:payer.csrf,password,pin:'5792',confirmation:'5792',mode:'create'})});
  assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/pay/app/pin?updated=1');
  assert.equal(vault.verifyPin(id,'5792'),true);
  r=await req('/pay/app/pin?updated=1',{headers:{cookie}});
  assert.equal(r.status,200);assert.match(await r.text(),/NIP actualizado/);
  r=await req('/pay/app/api/cards',{headers:{cookie:otherCookie}});
  assert.equal(r.status,200);const separated=await r.json();
  assert.deepEqual(separated.cards,[]);assert.equal(separated.pinConfigured,false);
  const raw=fs.readFileSync(file,'utf8');
  assert.equal(raw.includes('token_f03'),false);
  assert.equal(raw.includes('device_f03'),false);
  assert.equal(raw.includes('"5792"'),false);
  const restored=createVault({filePath:file,provider,pepper});
  assert.equal(restored.profile(id).cards.length,1);
  assert.equal(restored.profile(id).pinConfigured,true);
  assert.equal(restored.verifyPin(id,'5792'),true);
  assert.deepEqual(calls,['CUSTOMER','ADD_CARD','GET_CARD']);
 }finally{await new Promise(ok=>server.close(ok));fs.rmSync(temp,{recursive:true,force:true});}
});
