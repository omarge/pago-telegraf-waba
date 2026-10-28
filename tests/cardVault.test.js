'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const express=require('express');
const {createAccountService}=require('../src/accountService');
const {createVault}=require('../src/cardVault');
const {createSandboxProvider}=require('../src/openpayCardProvider');
const {createAccountRouter}=require('../src/accountRoutes');

const pepper='offline-test-pepper-at-least-32-chars-secret';
function mockProvider(){
 const customers=new Map(),cards=new Map(),calls=[];
 return {
  calls,merchantId:'merchant1234',publicKey:'pk_test_dummy',
  async createCustomer(profile){
   calls.push(['customer',profile.email]);
   const id='customer'+(customers.size+10000);
   customers.set(id,profile);return {id};
  },
  async addCard(customerId,tokenId,device){
   calls.push(['addCard',customerId,tokenId,device]);
   if(!customers.has(customerId))throw Error('missing customer');
   const id='card'+(cards.size+100000);
   const result={id,customer_id:customerId,brand:'visa',card_number:'4242',allows_charges:true};
   cards.set(id,result);return {id};
  },
  async getCard(customerId,id){
   calls.push(['getCard',customerId,id]);
   const card=cards.get(id);
   if(card?.customer_id!==customerId)throw Error('owner mismatch');
   return card;
  }
 };
}
test('Openpay adapter is disabled by default, regardless of checkout env',()=>{
 assert.equal(createSandboxProvider({
  enabled:false,merchantId:'merchant1234',privateKey:'fake',publicKey:'fake'
 }),null);
 const vault=createVault({filePath:null,pepper});
 const before=vault.profile('ab12abcd');
 assert.equal(before.enrollmentEnabled,false);
 assert.deepEqual(before.cards,[]);
 return assert.rejects(vault.enroll('ab12abcd',{consent:true}),/no habilitado/);
});
test('Sandbox token enrollment ties card to owner and persists only references',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waba-f03-'));
 const file=path.join(dir,'vault.json'),provider=mockProvider();
 try{
  const vault=createVault({filePath:file,provider,pepper});
  const owner='account-first-0001',other='account-other-0002';
  const params={
   tokenId:'token_test_123456',deviceSessionId:'device_test_123456',
   firstName:'Ana',lastName:'Prueba',email:'ana@example.com',consent:true
  };
  await assert.rejects(vault.enroll(owner,{...params,consent:false}),/consentimiento/);
  const card=await vault.enroll(owner,params);
  assert.deepEqual(card,{id:'card100000',brand:'visa',last4:'4242'});
  assert.equal(provider.calls.filter(x=>x[0]==='addCard').length,1);
  assert.equal(vault.profile(owner).cards.length,1);
  assert.equal(vault.profile(other).cards.length,0);
  const raw=fs.readFileSync(file,'utf8');
  assert.equal(raw.includes(params.tokenId),false);
  assert.equal(raw.includes(params.deviceSessionId),false);
  assert.equal(raw.includes('4111111111111111'),false);
  const again=createVault({filePath:file,provider,pepper});
  assert.deepEqual(again.profile(owner).cards,vault.profile(owner).cards);
  const second=await again.enroll(owner,{...params,tokenId:'token_test_654321'});
  assert.equal(second.id,'card100001');
  assert.equal(provider.calls.filter(x=>x[0]==='customer').length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Provider ownership mismatch never saves a card',async()=>{
 const fake=mockProvider();
 fake.getCard=async()=>({id:'card100000',customer_id:'customer_wrong',brand:'visa',card_number:'4242'});
 const vault=createVault({filePath:null,provider:fake,pepper});
 await assert.rejects(vault.enroll('account-first-0001',{
  tokenId:'token_test_123456',deviceSessionId:'device_test_123456',
  firstName:'Ana',lastName:'Prueba',email:'ana@example.com',consent:true
 }),/no confirmada/);
 assert.equal(vault.profile('account-first-0001').cards.length,0);
});
test('NIP requires current web-account password, stays scoped and supports change',()=>{
 const service=createAccountService({filePath:null});
 const a=service.register('ana@example.com','password-ana-012345');
 const b=service.register('bob@example.com','password-bob-012345');
 const aId=service.getSession(a.token).accountId,bId=service.getSession(b.token).accountId;
 const vault=createVault({filePath:null,pepper});
 const proof=(id,p)=>service.verifyPassword(id,p);
 assert.throws(()=>vault.setPin(aId,'4321','incorrect',proof),/Contraseña/);
 assert.throws(()=>vault.setPin(aId,'22222','password-ana-012345',proof),/cuatro/);
 assert.equal(vault.profile(aId).pinConfigured,false);
 vault.setPin(aId,'4321','password-ana-012345',proof);
 assert.equal(vault.profile(aId).pinConfigured,true);
 assert.equal(vault.profile(bId).pinConfigured,false);
 assert.equal(vault.verifyPin(bId,'4321'),false);
 assert.equal(vault.verifyPin(aId,'4321'),true);
 assert.equal(vault.verifyPin(aId,'0000'),false);
 assert.throws(()=>vault.setPin(aId,'5678','password-ana-012345',proof),/ya existe/);
 vault.setPin(aId,'5678','password-ana-012345',proof,{reset:true});
 assert.equal(vault.verifyPin(aId,'4321'),false);
 assert.equal(vault.verifyPin(aId,'5678'),true);
});
test('HTTP sessions isolate cards; NIP form verifies CSRF and password',async()=>{
 const accounts=createAccountService({filePath:null});
 const alice=accounts.register('alice@example.com','my-long-secret-alice-123');
 const bob=accounts.register('bob@example.com','my-long-secret-bob-123');
 const aId=accounts.getSession(alice.token).accountId;
 const provider=mockProvider();
 const vault=createVault({filePath:null,provider,pepper});
 await vault.enroll(aId,{tokenId:'token_alice_01234',deviceSessionId:'device_alice_01234',
  firstName:'Alice',lastName:'QA',email:'alice@example.com',consent:true});
 const app=express();
 app.use('/pay/app',createAccountRouter({service:accounts,vault}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const request=(route,opts={})=>fetch(base+route,{redirect:'manual',...opts});
  const aCookie='kashbit_web_session='+alice.token,bCookie='kashbit_web_session='+bob.token;
  let r=await request('/pay/app/cards');
  assert.equal(r.status,303);
  r=await request('/pay/app/api/cards',{headers:{cookie:bCookie}});
  assert.equal(r.status,200);
  assert.equal((await r.json()).cards.length,0);
  r=await request('/pay/app/api/cards',{headers:{cookie:aCookie}});
  assert.equal((await r.json()).cards.length,1);
  r=await request('/pay/app/enroll',{headers:{cookie:aCookie}});
  assert.equal(r.status,200);
  assert.match(await r.text(),/js.openpay.mx/);
  r=await request('/pay/app/assets/enroll.js',{headers:{cookie:aCookie}});
  assert.equal(r.status,200);
  assert.match(await r.text(),/OpenPay.token.create/);
  r=await request('/pay/app/api/cards/enroll',{
   method:'POST',headers:{cookie:aCookie,'Content-Type':'application/json'},
   body:JSON.stringify({tokenId:'token_test_123456',deviceSessionId:'device_test_123456'})
  });
  assert.equal(r.status,403);
  r=await request('/pay/app/pin',{
   method:'POST',headers:{cookie:aCookie},
   body:new URLSearchParams({_csrf:'invalid',password:'my-long-secret-alice-123',pin:'1234',confirmation:'1234'})
  });
  assert.equal(r.status,403);
  r=await request('/pay/app/pin',{
   method:'POST',headers:{cookie:aCookie},
   body:new URLSearchParams({_csrf:alice.csrf,password:'my-long-secret-alice-123',pin:'1234',confirmation:'1234',mode:'create'})
  });
  assert.equal(r.status,303);
  assert.equal(vault.verifyPin(aId,'1234'),true);
  assert.equal(vault.profile(accounts.getSession(bob.token).accountId).pinConfigured,false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
