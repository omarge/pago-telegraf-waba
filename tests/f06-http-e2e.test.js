'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const F09_SECRET='offline-test-meta-app-secret-for-f06-e2e';
const signedHeader=raw=>('sha256='+crypto.createHmac('sha256',F09_SECRET).update(raw).digest('hex'));
const {createWebhookApp}=require('../src/index');
const {createWebhook}=require('../src/webhook');
const {createFormApp}=require('../src/formServer');
const {createAccountService}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createVault}=require('../src/cardVault');
const {createStatementJournal}=require('../src/statementJournal');

const REQUEST_ID='KPR-'+'B'.repeat(32);
const COLLECTOR='5215555550002';
const PAYER='5215555550001';
function fixtureStore(){
 const invites=new Map(),requests=new Map(),conv=new Map();
 return {
  conv,
  createInvite(from,amount){const token='f06-test-invite';invites.set(token,{requesterId:from,amount});return token;},
  consumeInvite(token){const record=invites.get(token)||null;invites.delete(token);return record;},
  createRequest(requesterId,payerId,amount){
   const record={id:REQUEST_ID,requesterId,payerId,amount,state:'PENDING',created:Date.now()};
   requests.set(record.id,record);return record;
  },
  getRequest:id=>requests.get(id)
 };
}
function messages(){
 const sent=[],api={
  async sendMessage(to,body){sent.push({to,body});return {messages:[{id:'wamid.offline.f06'}]};},
  async sendList(to,body,button,sections){
   sent.push({to,body,button,sections});return {messages:[{id:'wamid.offline.menu'}]};
  }
 };
 return {sent,api};
}
async function serve(app){
 const server=await new Promise(ok=>{
  const instance=app.listen(0,'127.0.0.1',()=>ok(instance));
 });
 return {base:'http://127.0.0.1:'+server.address().port,
  stop:()=>new Promise(ok=>server.close(ok))};
}
const fetchLocal=(base,route,options={})=>fetch(base+route,{redirect:'manual',...options});
async function until(condition){
 for(let i=0;i<100;i++){
  if(condition())return;
  await new Promise(done=>setTimeout(done,10));
 }
 assert.fail('Timed out waiting for asynchronous webhook reply');
}
function fakeMetaBody(from,text){
 return {object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
  messages:[{from,type:'text',text:{body:text}}],
  contacts:[{wa_id:from,profile:{name:'Happy Path F06'}}]
 }}]}]};
}
async function sendInbound(base,from,body){
 const response=await fetchLocal(base,'/webhook',{
  method:'POST',headers:{'Content-Type':'application/json',
   'X-Hub-Signature-256':signedHeader(JSON.stringify(fakeMetaBody(from,body)))},
  body:JSON.stringify(fakeMetaBody(from,body))
 });
 assert.equal(response.status,200);
}
function linked(accounts,email,password,wa){
 const session=accounts.register(email,password);
 const accountId=accounts.getSession(session.token).accountId;
 const code=accounts.beginLink(session.token,session.csrf).code;
 assert.equal(accounts.bindFromWhatsApp(wa,code),true);
 return {accountId,session,password,email};
}

test('F06 HTTP E2E F00: Meta webhook -> cobrar -> 1000 -> pay/request -> mock charge -> WhatsApp notification',async()=>{
 const store=fixtureStore(),msg=messages(),accounts=createAccountService({filePath:null});
 const webhook=createWebhook({store,messenger:msg.api,accounts,
  baseUrl:'https://pagos.kashbit.bond',log:{log(){},error(e){throw Error(e);}}});
 const waba=await serve(createWebhookApp({onWebhook:webhook.handleWebhook,verifyToken:'f06-verify',appSecret:F09_SECRET,
  logger:{log(){},error(e){throw Error(e);}}}));
 const appRouter=createAccountRouter({
  service:accounts,vault:createVault({filePath:null}),
  requestStore:store,journal:createStatementJournal({filePath:null})
 });
 const charges=[];
 const form=await serve(createFormApp({
  paymentStore:store,accountRouter:appRouter,
  legacyChargeEnabled:true,
  merchant:'merchant-f06',privateKey:'fake-private-test',
  messenger:msg.api,charge:async(token,amount)=>{
   charges.push({token,amount});return {id:'chargeF06Test123',status:'completed'};
  }
 }));
 try{
  let response=await fetchLocal(waba.base,'/healthz');
  assert.equal(response.status,200);
  assert.equal(await response.text(),'ok');
  response=await fetchLocal(waba.base,'/webhook?hub.mode=subscribe&hub.verify_token=f06-verify&hub.challenge=12345');
  assert.equal(response.status,200);assert.equal(await response.text(),'12345');
  response=await fetchLocal(waba.base,'/webhook?hub.mode=subscribe&hub.verify_token=invalid&hub.challenge=12345');
  assert.equal(response.status,403);
  await sendInbound(waba.base,COLLECTOR,'cobrar');
  await until(()=>msg.sent.length===1);
  assert.match(msg.sent[0].body,/¿Cuánto quieres cobrar/);
  await sendInbound(waba.base,COLLECTOR,'1000');
  await until(()=>msg.sent.length===2);
  const link=msg.sent[1].body.match(/https:\/\/pagos\.kashbit\.bond\/pay\/request\/\S+/)?.[0];
  assert.ok(link);
  response=await fetchLocal(form.base,new URL(link).pathname);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/\$10\.00 MXN/);
  assert.match(html,new RegExp(REQUEST_ID));
  response=await fetchLocal(form.base,'/pay/charge',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({token_id:'openpay-test-token',amount:1000,holder:'Persona Prueba',
    request_id:REQUEST_ID,requester_id:COLLECTOR})
  });
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).status,'completed');
  assert.deepEqual(charges,[{token:'openpay-test-token',amount:1000}]);
  await until(()=>msg.sent.length===3);
  assert.equal(msg.sent[2].to,COLLECTOR);
  assert.match(msg.sent[2].body,/Pago completado/);
  assert.match(msg.sent[2].body,/\$10\.00 MXN/);
  assert.equal((await fetchLocal(form.base,new URL(link).pathname)).status,404);
 }finally{await Promise.all([waba.stop(),form.stop()]);}
});

test('F06 HTTP E2E F01-F05: menu -> request -> login -> saved card/NIP -> provider completed -> receipt -> both WhatsApp notices',async()=>{
 const store=fixtureStore(),msg=messages(),accounts=createAccountService({filePath:null});
 const payer=linked(accounts,'payer@example.com','payer-password-1234567',PAYER);
 const collector=linked(accounts,'collector@example.com','collector-password-1234567',COLLECTOR);
 const journal=createStatementJournal({filePath:null});
 const providerCalls=[];
 const provider={
  merchantId:'merchant12345',publicKey:'pk_test_f06',
  async createCustomer(){return {id:'customer12345678'};},
  async addCard(){return {id:'card12345678'};},
  async getCard(customer,id){
   providerCalls.push('GET_CARD');
   return {id,customer_id:customer,brand:'visa',card_number:'4242',allows_charges:true};
  },
  async chargeSavedCard(p){
   providerCalls.push('POST_CHARGE');
   assert.equal(p.amountCents,1000);
   assert.equal(p.requestId,REQUEST_ID);
   return {id:'charge12345678',order_id:p.requestId};
  },
  async getCharge(){
   providerCalls.push('GET_CHARGE');
   return {id:'charge12345678',order_id:REQUEST_ID,currency:'MXN',amount:10,status:'completed'};
  }
 };
 const vault=createVault({filePath:null,provider,pepper:'f06-happy-path-pin-pepper-over-32-characters'});
 const card=await vault.enroll(payer.accountId,{
  tokenId:'token-test-12345678',deviceSessionId:'device-test-12345678',
  firstName:'Usuario',lastName:'Prueba',email:payer.email,consent:true
 });
 vault.setPin(payer.accountId,'1234',payer.password,(id,password)=>accounts.verifyPassword(id,password));
 providerCalls.length=0;
 const webhook=createWebhook({store,messenger:msg.api,accounts,
  baseUrl:'https://pagos.kashbit.bond',log:{log(){},error(e){throw Error(e);}}});
 const waba=await serve(createWebhookApp({onWebhook:webhook.handleWebhook,verifyToken:'f06-verify',appSecret:F09_SECRET,
  logger:{log(){},error(e){throw Error(e);}}}));
 const router=createAccountRouter({service:accounts,vault,requestStore:store,
  notifier:msg.api.sendMessage,journal,savedCardEnabled:true});
 const form=await serve(createFormApp({paymentStore:store,accountRouter:router,
  merchant:'merchant12345',privateKey:'test-private',messenger:msg.api,
  showSavedCardOption:true,charge:async()=>{throw Error('Legacy payment endpoint must not be invoked');}}));
 try{
  await sendInbound(waba.base,COLLECTOR,'menu');
  await until(()=>msg.sent.length===1);
  assert.equal(msg.sent[0].sections[0].rows.length,8);
  // Exercise the same interactive reply used by WhatsApp Cloud API.
  const selected={object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{
   from:COLLECTOR,type:'interactive',interactive:{list_reply:{id:'menu:charge'}}
  }]}}]}]};
  let response=await fetchLocal(waba.base,'/webhook',{method:'POST',
   headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':signedHeader(JSON.stringify(selected))},
   body:JSON.stringify(selected)});
  assert.equal(response.status,200);
  await until(()=>msg.sent.length===2);
  assert.match(msg.sent[1].body,/¿Cuánto quieres cobrar/);
  await sendInbound(waba.base,COLLECTOR,'1000');
  await until(()=>msg.sent.length===3);
  const invite=msg.sent[2].body.match(/https:\/\/pagos\.kashbit\.bond\/pay\/request\/\S+/)?.[0];
  assert.ok(invite);
  response=await fetchLocal(form.base,new URL(invite).pathname);
  assert.equal(response.status,200);
  const checkout=await response.text();
  assert.match(checkout,/Pagar con tarjeta guardada/);
  assert.match(checkout,/\$10\.00 MXN/);
  const route='/pay/app/pay/'+REQUEST_ID;
  response=await fetchLocal(form.base,route);
  assert.equal(response.status,303);
  assert.match(response.headers.get('location'),/\/pay\/app\/login\?next=/);
  response=await fetchLocal(form.base,'/pay/app/login',{
   method:'POST',body:new URLSearchParams({
    email:payer.email,password:payer.password,next:route
   })
  });
  assert.equal(response.status,303);
  assert.equal(response.headers.get('location'),route);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  response=await fetchLocal(form.base,route,{headers:{cookie}});
  assert.equal(response.status,200);
  const paymentForm=await response.text();
  assert.match(paymentForm,/Confirmar pago \$10\.00/);
  assert.match(paymentForm,/4242/);
  const csrf=accounts.getSession(cookie.split('=')[1]).csrf;
  response=await fetchLocal(form.base,route,{
   method:'POST',headers:{cookie},
   body:new URLSearchParams({
    _csrf:csrf,cardId:card.id,pin:'1234',deviceSessionId:'device-f06-1234',consent:'yes'
   })
  });
  assert.equal(response.status,200);
  const receipt=await response.text();
  assert.match(receipt,/Pago completado/);
  assert.match(receipt,/charge12345678/);
  assert.deepEqual(providerCalls,['GET_CARD','POST_CHARGE','GET_CHARGE']);
  assert.equal(store.getRequest(REQUEST_ID).state,'PAID');
  assert.equal(journal.listForAccount(payer.accountId,accounts).length,1);
  assert.equal(journal.listForAccount(collector.accountId,accounts).length,1);
  response=await fetchLocal(form.base,'/pay/app/statement',{headers:{cookie}});
  assert.equal(response.status,200);
  assert.match(await response.text(),/\$10\.00 MXN/);
  response=await fetchLocal(form.base,'/pay/app/receipt/'+REQUEST_ID,{headers:{cookie}});
  assert.equal(response.status,200);
  assert.match(await response.text(),/charge12345678/);
  const notices=msg.sent.filter(m=>m.body?.includes('✅ Pago completado'));
  assert.deepEqual(notices.map(x=>x.to).sort(),[COLLECTOR,PAYER].sort());
  assert.equal(providerCalls.filter(x=>x==='POST_CHARGE').length,1);
 }finally{await Promise.all([waba.stop(),form.stop()]);}
});
