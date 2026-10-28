'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express');
const {createVault}=require('../src/cardVault');
const {createAccountService}=require('../src/accountService');
const {createSavedCardFlow}=require('../src/savedCardFlow');
const {createStatementJournal}=require('../src/statementJournal');
const {createAccountRouter}=require('../src/accountRoutes');

const PIN_PEPPER='offline-only-strong-pin-pepper-value-over-32';
const REQUEST_ID='KPR-'+'A'.repeat(32);
function makeFixture(){
 const calls=[];
 const provider={
  merchantId:'merchant12345',publicKey:'pk_test_only',
  async createCustomer(){return {id:'customer12345'};},
  async addCard(){return {id:'card12345678'};},
  async getCard(customer,id){
   calls.push('getCard');
   return {id,customer_id:customer,brand:'visa',card_number:'4242',allows_charges:true};
  },
  async chargeSavedCard(input){
   calls.push('charge');
   return {id:'charge12345678',order_id:input.requestId,status:'completed'};
  },
  async getCharge(_customer,_chargeId){
   calls.push('getCharge');
   return {id:'charge12345678',order_id:REQUEST_ID,amount:10,
    currency:'MXN',status:'completed'};
  }
 };
 const accounts=createAccountService({filePath:null});
 const web=accounts.register('payer@example.com','long-password-0123456789');
 const accountId=accounts.getSession(web.token).accountId;
 const challenge=accounts.beginLink(web.token,web.csrf).code;
 assert.equal(accounts.bindFromWhatsApp('5215555550001',challenge),true);
 const vault=createVault({filePath:null,pepper:PIN_PEPPER,provider});
 const request={id:REQUEST_ID,requesterId:'5215555550002',payerId:'waba-payer',
  amount:1000,state:'PENDING',created:Date.now()};
 const requestStore={getRequest:id=>id===REQUEST_ID?request:null};
 const journal=createStatementJournal({filePath:null});
 const messages=[];
 const notify=async(to,msg)=>{messages.push([to,msg]);};
 async function setup(){
  const card=await vault.enroll(accountId,{
   tokenId:'token123456789',deviceSessionId:'device123456789',
   firstName:'Ana',lastName:'Prueba',email:'payer@example.com',consent:true
  });
  vault.setPin(accountId,'1234','long-password-0123456789',
   (id,password)=>accounts.verifyPassword(id,password));
  calls.length=0;
  return card;
 }
 return {calls,provider,accounts,web,accountId,vault,requestStore,request,messages,notify,setup,journal};
}
test('saved-card happy path: select, PIN, explicit consent, one charge, verified GET, two notices',async()=>{
 const f=makeFixture();
 const card=await f.setup();
 const flow=createSavedCardFlow({journal:f.journal,
  vault:f.vault,requestStore:f.requestStore,accounts:f.accounts,
  notify:f.notify,enabled:true
 });
 const view=flow.view(f.accountId,REQUEST_ID);
 assert.equal(view.cards[0].last4,'4242');
 assert.equal(view.amountCents,1000);
 const result=await flow.pay({
  accountId:f.accountId,requestId:REQUEST_ID,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:true,csrfVerified:true
 });
 assert.equal(result.state,'PAID');
 assert.equal(result.chargeId,'charge12345678');
 assert.equal(f.request.state,'PAID');
 assert.deepEqual(f.calls,['getCard','charge','getCharge']);
 assert.equal(f.messages.length,2);
 assert.ok(f.messages.some(m=>m[0]==='5215555550001'));
 assert.ok(f.messages.some(m=>m[0]==='5215555550002'));
 assert.ok(f.messages.every(m=>m[1].includes('$10.00 MXN')));
 const repeated=await flow.pay({
  accountId:f.accountId,requestId:REQUEST_ID,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:true,csrfVerified:true
 });
 assert.equal(repeated.state,'PAID');
 assert.equal(f.calls.filter(x=>x==='charge').length,1);
});
test('saved-card route is opt-in and cannot charge without final consent',async()=>{
 const f=makeFixture(),card=await f.setup();
 const disabled=createSavedCardFlow({journal:f.journal,vault:f.vault,requestStore:f.requestStore,accounts:f.accounts});
 assert.equal((await disabled.pay({
  accountId:f.accountId,requestId:REQUEST_ID,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:true,csrfVerified:true
 })).state,'DISABLED');
 const flow=createSavedCardFlow({journal:f.journal,vault:f.vault,requestStore:f.requestStore,accounts:f.accounts,enabled:true});
 assert.equal((await flow.pay({
  accountId:f.accountId,requestId:REQUEST_ID,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:false,csrfVerified:true
 })).state,'INVALID_CONFIRMATION');
 assert.equal(f.calls.includes('charge'),false);
});
test('verified noncompleted Openpay outcome does not say paid or retry',async()=>{
 const f=makeFixture(),card=await f.setup();
 f.provider.getCharge=async()=>({id:'charge12345678',order_id:REQUEST_ID,
  amount:10,currency:'MXN',status:'in_progress'});
 const flow=createSavedCardFlow({journal:f.journal,vault:f.vault,requestStore:f.requestStore,accounts:f.accounts,notify:f.notify,enabled:true});
 const result=await flow.pay({
  accountId:f.accountId,requestId:REQUEST_ID,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:true,csrfVerified:true
 });
 assert.equal(result.state,'UNKNOWN_SAVED_CARD');
 assert.equal(f.request.state,'UNKNOWN_SAVED_CARD');
 assert.equal(f.messages.length,0);
 const again=await flow.pay({
  accountId:f.accountId,requestId:REQUEST_ID,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:true,csrfVerified:true
 });
 assert.equal(again.state,'UNKNOWN_SAVED_CARD');
 assert.equal(f.calls.filter(x=>x==='charge').length,1);
});
test('web flow: login continuation, authenticated form, PIN and payment receipt',async()=>{
 const f=makeFixture(),card=await f.setup();
 const app=express();
 app.use('/pay/app',createAccountRouter({journal:f.journal,
  service:f.accounts,vault:f.vault,requestStore:f.requestStore,
  notifier:f.notify,savedCardEnabled:true
 }));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const request=(uri,options={})=>fetch(base+uri,{redirect:'manual',...options});
  const payUrl='/pay/app/pay/'+REQUEST_ID;
  let r=await request(payUrl);
  assert.equal(r.status,303);
  assert.match(r.headers.get('location'),/\/pay\/app\/login\?next=/);
  r=await request(r.headers.get('location'));
  assert.equal(r.status,200);
  assert.match(await r.text(),/name="next"/);
  r=await request('/pay/app/login',{
   method:'POST',
   body:new URLSearchParams({
    email:'payer@example.com',password:'long-password-0123456789',
    next:payUrl
   })
  });
  assert.equal(r.status,303);
  assert.equal(r.headers.get('location'),payUrl);
  const cookie=r.headers.get('set-cookie').split(';')[0];
  r=await request(payUrl,{headers:{cookie}});
  assert.equal(r.status,200);
  const html=await r.text();
  assert.match(html,/Confirmar pago \$10.00/);
  assert.match(html,/4242/);
  assert.match(html,/name="pin"/);
  r=await request('/pay/app/assets/saved-pay.js',{headers:{cookie}});
  assert.equal(r.status,200);
  assert.match(await r.text(),/OpenPay.deviceData.setup/);
  r=await request(payUrl,{
   method:'POST',headers:{cookie},
   body:new URLSearchParams({
    _csrf:f.accounts.getSession(cookie.split('=')[1]).csrf,
    cardId:card.id,pin:'1234',deviceSessionId:'device123456789',consent:'yes'
   })
  });
  assert.equal(r.status,200);
  assert.match(await r.text(),/Pago completado/);
  assert.equal(f.messages.length,2);
  assert.equal(f.request.state,'PAID');
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('F04 receipt never claims WhatsApp was requested or delivered; links to the persisted receipt',()=>{
 const {receipt}=require('../src/savedCardRoutes');
 const id='KPR-'+'A'.repeat(32);
 const html=receipt({
  state:'PAID',chargeId:'charge12345678',amountCents:1000
 },{requestId:id});
 assert.match(html,/Pago completado/);
 assert.match(html,/Ver comprobante/);
 assert.match(html,new RegExp('/pay/app/receipt/'+id));
 assert.match(html,/La entrega por WhatsApp no está confirmada/);
 assert.doesNotMatch(html,/Se solicitó la notificación|Se envió la notificación|WhatsApp entregado/);
});
