'use strict';
// F07: real HTTP loopback, two independent WABA accounts, fake Meta and Openpay.
// NEVER contacts Graph API, Openpay, BusinessOS, or any live server.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const F09_SECRET='offline-test-meta-app-secret-for-f07-e2e';
const signedHeader=raw=>('sha256='+crypto.createHmac('sha256',F09_SECRET).update(raw).digest('hex'));
const {createWebhookApp}=require('../src/index');
const {createWebhook}=require('../src/webhook');
const {createFormApp}=require('../src/formServer');
const {createAccountService}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createVault}=require('../src/cardVault');
const {createStatementJournal}=require('../src/statementJournal');
const {createVerifiedPaymentReference}=require('../src/businessosPaymentReference');

const REQUEST='KPR-'+'C'.repeat(32);
const COLLECTOR='5215555550002',PAYER='5215555550001';
const CHARGE='chargeF07Sandbox123';
const PIN_PEPPER='f07-local-pin-pepper-at-least-32-characters';
function fixture(){
 const accounts=createAccountService({filePath:null});
 function user(email,pass,wa){
  const s=accounts.register(email,pass);
  const id=accounts.getSession(s.token).accountId;
  if(wa){
   const challenge=accounts.beginLink(s.token,s.csrf);
   assert.equal(accounts.bindFromWhatsApp(wa,challenge.code),true);
  }
  return {email,pass,id,token:s.token,csrf:s.csrf,wa};
 }
 const payer=user('payer-f07@example.com','payer-f07-password-123456',PAYER);
 const collector=user('collector-f07@example.com','collector-f07-password-123456',COLLECTOR);
 const outsider=user('outsider-f07@example.com','outsider-f07-password-123456',null);
 const invites=new Map(),requests=new Map(),conv=new Map();
 const store={
  conv,
  createInvite(from,amount){const code='f07-invite-once';invites.set(code,{requesterId:from,amount});return code;},
  consumeInvite(code){const inv=invites.get(code)||null;invites.delete(code);return inv;},
  createRequest(requesterId,payerId,amount){
   const r={id:REQUEST,requesterId,payerId,amount,state:'PENDING',created:Date.now()};
   requests.set(REQUEST,r);return r;
  },
  getRequest:id=>requests.get(id)
 };
 const calls=[],outgoing=[];
 const provider={
  merchantId:'f07-merchant-sandbox-fake',publicKey:'pk_test_f07',
  async createCustomer(){return {id:'customerF07Test123'};},
  async addCard(){return {id:'cardF07Test123'};},
  async getCard(customerId,cardId){
   calls.push('GET_CARD');
   return {id:cardId,customer_id:customerId,brand:'visa',
    card_number:'4242',allows_charges:true};
  },
  async chargeSavedCard(args){
   calls.push('POST_CHARGE');
   assert.equal(args.amountCents,1000);
   assert.equal(args.requestId,REQUEST);
   return {id:CHARGE};
  },
  async getCharge(){
   calls.push('GET_CHARGE');
   return {id:CHARGE,order_id:REQUEST,currency:'MXN',amount:10,status:'completed'};
  }
 };
 const vault=createVault({filePath:null,provider,pepper:PIN_PEPPER});
 const journal=createStatementJournal({filePath:null});
 const messenger={
  async sendMessage(to,body){outgoing.push({to,body});return {messages:[{id:'wamid.f07.mock.accepted'}]};},
  async sendList(to,body,button,sections){outgoing.push({to,body,button,sections});return {messages:[{id:'wamid.f07.mock.menu'}]};}
 };
 async function enroll(){
  const card=await vault.enroll(payer.id,{
   tokenId:'tokF07Sandbox123',deviceSessionId:'device-f07-enroll-1234',
   firstName:'Prueba',lastName:'Pagador',email:payer.email,consent:true
  });
  vault.setPin(payer.id,'1234',payer.pass,(id,pw)=>accounts.verifyPassword(id,pw));
  calls.length=0;
  return card;
 }
 function formApp(){
  const router=createAccountRouter({service:accounts,vault,requestStore:store,
   notifier:messenger.sendMessage,journal,savedCardEnabled:true});
  return createFormApp({paymentStore:store,accountRouter:router,
   messenger,merchant:'f07-mock-merchant',privateKey:'fake-private-f07',
   showSavedCardOption:true,
   charge:async()=>{throw Error('Legacy token charge is forbidden in F07 fake provider E2E');}});
 }
 function webhookApp(){
  const hook=createWebhook({accounts,store,messenger,baseUrl:'https://pagos.kashbit.bond',
   log:{log(){},error(e){throw Error(e);}}});
  return createWebhookApp({verifyToken:'f07-verify',appSecret:F09_SECRET,onWebhook:hook.handleWebhook,
   logger:{log(){},error(e){throw Error(e);}}});
 }
 return {accounts,payer,collector,outsider,store,calls,outgoing,provider,
  vault,journal,messenger,enroll,formApp,webhookApp};
}
async function serve(app){
 const s=await new Promise(done=>{const server=app.listen(0,'127.0.0.1',()=>done(server));});
 return {base:'http://127.0.0.1:'+s.address().port,close:()=>new Promise(done=>s.close(done))};
}
function call(s,path,opts={}){
 return fetch(s.base+path,{redirect:'manual',...opts});
}
function inbound(from,message){
 const item=typeof message==='string'
  ?{from,type:'text',text:{body:message}}
  :{from,type:'interactive',interactive:{list_reply:{id:message.selection}}};
 return {object:'whatsapp_business_account',entry:[{changes:[{
  field:'messages',value:{messages:[item]}
 }]}]};
}
async function receive(s,from,message){
 const resp=await call(s,'/webhook',{method:'POST',
  headers:{'Content-Type':'application/json',
   'X-Hub-Signature-256':signedHeader(JSON.stringify(inbound(from,message)))},
  body:JSON.stringify(inbound(from,message))});
 assert.equal(resp.status,200);
}
async function until(predicate){
 for(let i=0;i<100;i++){
  if(predicate())return;
  await new Promise(done=>setTimeout(done,10));
 }
 assert.fail('F07 async webhook failed to dispatch mock message');
}
async function login(s,u){
 const response=await call(s,'/pay/app/login',{method:'POST',
  body:new URLSearchParams({email:u.email,password:u.pass})});
 assert.equal(response.status,303);
 const cookie=response.headers.get('set-cookie')?.split(';')[0];
 assert.match(cookie||'',/^kashbit_web_session=/);
 return cookie;
}
function postPay(cookie,csrf,card){
 return {method:'POST',headers:{cookie},
  body:new URLSearchParams({_csrf:csrf,cardId:card.id,
   pin:'1234',deviceSessionId:'device-session-f07-98765',consent:'yes'})};
}
test('F07 whole two-party happy path via HTTP: menu, request once, login, saved card/NIP, journal, two receipts, replay, BusinessOS ref',async()=>{
 const f=fixture();const card=await f.enroll();
 const ws=await serve(f.webhookApp()),form=await serve(f.formApp());
 try{
  await receive(ws,COLLECTOR,'menu');
  await until(()=>f.outgoing.length===1);
  assert.equal(f.outgoing[0].to,COLLECTOR);
  assert.equal(f.outgoing[0].sections[0].rows.length,8);
  await receive(ws,COLLECTOR,{selection:'menu:charge'});
  await until(()=>f.outgoing.length===2);
  assert.match(f.outgoing[1].body,/¿Cuánto quieres cobrar/);
  await receive(ws,COLLECTOR,'1000');
  await until(()=>f.outgoing.length===3);
  const generated=f.outgoing[2].body.match(/https:\/\/pagos\.kashbit\.bond\/pay\/request\/\S+/)?.[0];
  assert.ok(generated);
  let r=await call(form,new URL(generated).pathname);
  assert.equal(r.status,200);
  assert.match(await r.text(),/\$10\.00 MXN/);
  assert.equal((await call(form,new URL(generated).pathname)).status,404);
  const payerCookie=await login(form,f.payer);
  const collectorCookie=await login(form,f.collector);
  const outsiderCookie=await login(form,f.outsider);
  for(const feature of ['','cards','pin','settings','statement','receipts']){
   const response=await call(form,'/pay/app/'+feature,{headers:{cookie:payerCookie}});
   assert.equal(response.status,200,'microapp '+feature);
  }
  r=await call(form,'/pay/app/pay/'+REQUEST,{headers:{cookie:payerCookie}});
  assert.equal(r.status,200);
  assert.match(await r.text(),/Confirmar pago \$10\.00/);
  assert.equal((await call(form,'/pay/app/pay/'+REQUEST,
   postPay(payerCookie,'bad-csrf',card))).status,400);
  assert.equal(f.calls.filter(x=>x==='POST_CHARGE').length,0);
  const csrf=f.accounts.getSession(payerCookie.split('=')[1]).csrf;
  r=await call(form,'/pay/app/pay/'+REQUEST,postPay(payerCookie,csrf,card));
  assert.equal(r.status,200);
  assert.match(await r.text(),/Pago completado/);
  assert.deepEqual(f.calls,['GET_CARD','POST_CHARGE','GET_CHARGE']);
  assert.equal(f.store.getRequest(REQUEST).state,'PAID');
  assert.equal(f.outgoing.filter(x=>x.body?.includes('✅ Pago completado')).length,2);
  assert.deepEqual(
   f.outgoing.filter(x=>x.body?.includes('✅ Pago completado')).map(x=>x.to).sort(),
   [COLLECTOR,PAYER].sort()
  );
  for(const cookie of [payerCookie,collectorCookie]){
   r=await call(form,'/pay/app/statement',{headers:{cookie}});
   assert.equal(r.status,200);
   assert.match(await r.text(),/\$10\.00 MXN/);
   r=await call(form,'/pay/app/receipts',{headers:{cookie}});
   assert.equal(r.status,200);
   assert.match(await r.text(),/Ver comprobante/);
   r=await call(form,'/pay/app/receipt/'+REQUEST,{headers:{cookie}});
   assert.equal(r.status,200);
   assert.match(await r.text(),new RegExp(CHARGE));
  }
  assert.equal((await call(form,'/pay/app/receipt/'+REQUEST,
   {headers:{cookie:outsiderCookie}})).status,404);
  const ref=createVerifiedPaymentReference({
   accountId:f.payer.id,requestId:REQUEST,journal:f.journal,accounts:f.accounts
  });
  assert.equal(ref.integrationState,'LOCAL_REFERENCE_ONLY');
  assert.equal(ref.amountDecimal,'10.00');
  assert.equal(createVerifiedPaymentReference({
   accountId:f.collector.id,requestId:REQUEST,journal:f.journal,accounts:f.accounts
  }),null);
  r=await call(form,'/pay/app/pay/'+REQUEST,postPay(payerCookie,csrf,card));
  assert.equal(r.status,200);
  const repeatReceipt=await r.text();
  assert.doesNotMatch(repeatReceipt,/NaN|undefined/,'repeated receipt must retain verified amount');
  assert.match(repeatReceipt,/Importe: \$10\.00 MXN/);
  assert.equal(f.calls.filter(x=>x==='POST_CHARGE').length,1);
  assert.equal(f.journal.listForAccount(f.payer.id,f.accounts).length,1);
  assert.equal(f.outgoing.filter(x=>x.body?.includes('✅ Pago completado')).length,2);
 }finally{await Promise.all([ws.close(),form.close()]);}
});
test('F07 simultaneous retry during in-flight fake PSP operation never posts twice',async()=>{
 const f=fixture();const card=await f.enroll();
 f.store.createRequest(COLLECTOR,'web-payer',1000);
 let release;
 let signal;
 const started=new Promise(resolve=>{signal=resolve;});
 f.provider.chargeSavedCard=async input=>{
  f.calls.push('POST_CHARGE');
  signal();
  assert.equal(input.amountCents,1000);
  return new Promise(resolve=>{release=resolve;});
 };
 const form=await serve(f.formApp());
 try{
  const cookie=await login(form,f.payer),csrf=f.accounts.getSession(cookie.split('=')[1]).csrf;
  const first=call(form,'/pay/app/pay/'+REQUEST,postPay(cookie,csrf,card));
  await started;
  const second=await call(form,'/pay/app/pay/'+REQUEST,postPay(cookie,csrf,card));
  assert.equal(second.status,400);
  assert.match(await second.text(),/Resultado pendiente/);
  assert.equal(f.calls.filter(x=>x==='POST_CHARGE').length,1);
  release({id:CHARGE});
  const result=await first;
  assert.equal(result.status,200);
  assert.match(await result.text(),/Pago completado/);
  assert.equal(f.calls.filter(x=>x==='POST_CHARGE').length,1);
  assert.equal(f.journal.listForAccount(f.payer.id,f.accounts).length,1);
 }finally{await form.close();}
});
test('F07 uncertain simulated provider GET never marks PAID, emits receipt or retries charge',async()=>{
 const f=fixture();const card=await f.enroll();
 f.store.createRequest(COLLECTOR,'web-payer',1000);
 f.provider.getCharge=async()=>{
  f.calls.push('GET_CHARGE');
  return {id:CHARGE,order_id:REQUEST,currency:'MXN',amount:10,status:'in_progress'};
 };
 const form=await serve(f.formApp());
 try{
  const cookie=await login(form,f.payer),csrf=f.accounts.getSession(cookie.split('=')[1]).csrf;
  const first=await call(form,'/pay/app/pay/'+REQUEST,postPay(cookie,csrf,card));
  assert.equal(first.status,202);
  assert.match(await first.text(),/No lo repitas/);
  assert.equal(f.store.getRequest(REQUEST).state,'UNKNOWN_SAVED_CARD');
  const again=await call(form,'/pay/app/pay/'+REQUEST,postPay(cookie,csrf,card));
  assert.equal(again.status,202);
  assert.equal(f.calls.filter(x=>x==='POST_CHARGE').length,1);
  assert.equal(f.journal.listForAccount(f.payer.id,f.accounts).length,0);
  assert.equal(f.outgoing.length,0);
  assert.equal(createVerifiedPaymentReference({
   accountId:f.payer.id,requestId:REQUEST,journal:f.journal,accounts:f.accounts
  }),null);
 }finally{await form.close();}
});
