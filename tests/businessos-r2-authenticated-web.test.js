'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAccountService}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createVault}=require('../src/cardVault');
const {createFormApp}=require('../src/formServer');
const {createBusinessosChannelFlow}=require('../src/businessosChannelFlow');
const {createBusinessosAuthorizationAdapter}=require('../src/businessosAuthorizationAdapter');
const REQUEST='KPR-'+'B'.repeat(32);
const route='/pay/app/businessos/authorize/'+REQUEST;
function fixture({bound=true,enabled=true,unknown=false}={}){
 const accounts=createAccountService({filePath:null});
 const ps=accounts.register('payer-r2@example.com','payer-password-r2-1234');
 const os=accounts.register('other-r2@example.com','other-password-r2-1234');
 const payer=accounts.getSession(ps.token),other=accounts.getSession(os.token);
 const payment={id:REQUEST,amount:1275,state:'PENDING',payerAccountId:bound?payer.accountId:null};
 const store={getRequest:id=>id===REQUEST?payment:null};
 const sent=[],resolved=[];
 const trusted={accountId:payer.accountId,tenantId:'tenant-r2',
  customerId:'customer-businessos-r2',paymentMethodReferenceProvider:'OPENPAY',
  paymentMethodReference:'vault-opaque-r2',delegatedBearer:'delegate-r2-offline-123456789',
  fraudAssessmentId:'fraud-approved-r2',fraudDecision:'APPROVE',
  clientIpAddress:'127.0.0.1'};
 const adapter=createBusinessosAuthorizationAdapter({enabled:true,transport:async req=>{
  sent.push(req);
  return {httpStatus:200,body:{tenantId:trusted.tenantId,
   paymentIntentId:'int-r2-canonical-123',paymentAttemptId:'att-r2-canonical-123',
   status:unknown?'UNKNOWN':'AUTHORIZED'}};
 }});
 const flow=createBusinessosChannelFlow({enabled,requestStore:store,
  resolveTrustedAuthority:async ctx=>{resolved.push(ctx);return trusted;},adapter});
 const router=createAccountRouter({service:accounts,requestStore:store,
  vault:createVault({filePath:null}),savedCardEnabled:false,businessosFlow:flow});
 const app=createFormApp({accountRouter:router,paymentStore:store,
  merchant:'fake',privateKey:'fake',charge:async()=>{throw Error('no Openpay');}});
 return {accounts,ps,os,payer,other,payment,store,sent,resolved,trusted,flow,app};
}
async function serve(app){
 const s=await new Promise(ok=>{const a=app.listen(0,'127.0.0.1',()=>ok(a));});
 return {url:'http://127.0.0.1:'+s.address().port,
  close:()=>new Promise(ok=>s.close(ok))};
}
const ck=t=>'kashbit_web_session='+t;
const get=(s,t)=>fetch(s.url+route,{redirect:'manual',
 headers:t?{Cookie:ck(t)}:{}});
const post=(s,t,csrf,fields={})=>fetch(s.url+route,{
 method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',
 ...(t?{Cookie:ck(t)}:{})},
 body:new URLSearchParams({_csrf:csrf,consent:'yes',...fields})
});
test('R2 disabled by default no BusinessOS POST/GET routes mounted',async()=>{
 const f=fixture({enabled:false}),s=await serve(f.app);
 try{
  assert.equal((await get(s,f.ps.token)).status,404);
  assert.equal((await post(s,f.ps.token,f.payer.csrf)).status,404);
  assert.equal(f.sent.length,0);
 }finally{await s.close();}
});
test('R2 auth: guest redirected, other account gets 404, payer sees amount only',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  assert.equal((await get(s)).status,303);
  assert.equal((await get(s,f.os.token)).status,404);
  const r=await get(s,f.ps.token);
  assert.equal(r.status,200);
  const html=await r.text();
  assert.match(html,/\$12.75 MXN/);
  assert.match(html,/La autorización no confirma la captura ni el pago/);
  assert.ok(!html.includes(f.trusted.delegatedBearer));
  assert.equal(f.sent.length,0);
  assert.equal(f.resolved.length,0);
 }finally{await s.close();}
});
test('R2 unbound invitation cannot submit BusinessOS payment',async()=>{
 const f=fixture({bound:false}),s=await serve(f.app);
 try{
  assert.equal((await get(s,f.ps.token)).status,404);
  assert.equal((await post(s,f.ps.token,f.payer.csrf)).status,404);
  assert.equal(f.sent.length,0);
  assert.equal(f.resolved.length,0);
 }finally{await s.close();}
});
test('R2 invalid CSRF or no consent prevents authority lookup and transport',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  assert.equal((await post(s,f.ps.token,'tampered')).status,403);
  assert.equal((await post(s,f.ps.token,f.payer.csrf,{consent:'no'})).status,403);
  assert.equal(f.sent.length,0);
  assert.equal(f.resolved.length,0);
 }finally{await s.close();}
});
test('R2 browser-forged tenant, money, fraud, method, bearer ignored by server trusted resolver',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  const r=await post(s,f.ps.token,f.payer.csrf,{
   tenantId:'evil-tenant',amount:'999999999',fraudDecision:'APPROVE',
   customerId:'evil-customer',delegatedBearer:'evil-token',
   paymentMethodReference:'evil-card'});
  assert.equal(r.status,202);
  const html=await r.text();
  assert.match(html,/Autorización recibida. Pago no confirmado/);
  assert.doesNotMatch(html,/Pago completado/);
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].body.tenantId,'tenant-r2');
  assert.equal(f.sent[0].body.amount,'12.75');
  assert.equal(f.sent[0].body.customerId,'customer-businessos-r2');
  assert.equal(f.sent[0].delegatedBearer,f.trusted.delegatedBearer);
  assert.deepEqual(f.resolved,[{accountId:f.payer.accountId,requestId:REQUEST}]);
  assert.equal(f.payment.state,'PENDING');
  assert.equal((await post(s,f.ps.token,f.payer.csrf)).status,202);
  assert.equal(f.sent.length,1);
 }finally{await s.close();}
});
test('R2 foreign session cannot read replay or dispatch another authorization',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  assert.equal((await post(s,f.ps.token,f.payer.csrf)).status,202);
  assert.equal((await post(s,f.os.token,f.other.csrf)).status,404);
  assert.equal(f.sent.length,1);
  assert.equal(f.resolved.length,1);
 }finally{await s.close();}
});
test('R2 UNKNOWN remains indeterminate and never retries',async()=>{
 const f=fixture({unknown:true}),s=await serve(f.app);
 try{
  const r=await post(s,f.ps.token,f.payer.csrf);
  assert.equal(r.status,202);
  assert.match(await r.text(),/No repitas la operación/);
  assert.equal((await post(s,f.ps.token,f.payer.csrf)).status,202);
  assert.equal(f.sent.length,1);
  assert.equal(f.payment.state,'PENDING');
 }finally{await s.close();}
});
test('R2 async trusted resolver cannot authorize request changed during await',async()=>{
 const f=fixture();
 let release,started;
 const signal=new Promise(ok=>{started=ok;});
 let sent=0;
 const flow=createBusinessosChannelFlow({enabled:true,requestStore:f.store,
  resolveTrustedAuthority:async()=>{started();return new Promise(ok=>{release=()=>ok(f.trusted);});},
  adapter:{authorize:async()=>{sent++;return {state:'AUTHORIZED_PENDING_CAPTURE'};}}});
 const task=flow.authorize({accountId:f.payer.accountId,
  requestId:REQUEST,consent:true,csrfVerified:true});
 await signal;f.payment.amount=4500;release();
 assert.equal((await task).state,'REQUEST_CHANGED_NO_EXECUTION');
 assert.equal(sent,0);
});
test('R2 flow refuses unbound payer before trusted authority resolver',async()=>{
 const f=fixture({bound:false});
 assert.equal((await f.flow.authorize({
  accountId:f.payer.accountId,requestId:REQUEST,consent:true,csrfVerified:true
 })).state,'NOT_FOUND');
 assert.equal(f.resolved.length,0);
 assert.equal(f.sent.length,0);
});
