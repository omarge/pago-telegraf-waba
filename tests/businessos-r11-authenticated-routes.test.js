'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAccountService}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createFormApp}=require('../src/formServer');
const {createVault}=require('../src/cardVault');
const ID='KPR-'+'C'.repeat(32);
function fixture({fenced=true,sourceFails=false,flowResult='AUTHORIZED_PENDING_CAPTURE_NOT_PAID'}={}){
 const service=createAccountService({filePath:null});
 const p=service.register('r11-h4-payer@example.test','r11-h4-payer-password-12345');
 const q=service.register('r11-h4-attacker@example.test','r11-h4-attacker-password-12345');
 const payer=service.getSession(p.token),attacker=service.getSession(q.token);
 const seen=[],reads=[];
 const requestStore={getRequest:async id=>{
  reads.push(id);
  if(sourceFails)throw Error('private-database-credentials');
  return id===ID?{id:ID,amount:1275,state:'PENDING',payerAccountId:payer.accountId}:null;
 }};
 const flow={isEnabled:fenced,authorizeOnce:async input=>{
  seen.push(input);return {state:flowResult};
 }};
 const router=createAccountRouter({service,
  vault:createVault({filePath:null}),savedCardEnabled:false,
  businessosFencedAuthorization:flow,
  businessosFencedRequestStore:requestStore});
 const app=createFormApp({accountRouter:router,merchant:'offline',privateKey:'offline',
  charge:async()=>{throw Error('UNEXPECTED_OPENPAY');}});
 return {service,p,q,payer,attacker,seen,reads,app,flow,requestStore};
}
async function serve(app){
 const srv=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 return {url:'http://127.0.0.1:'+srv.address().port,
  close:()=>new Promise(resolve=>srv.close(resolve))};
}
const url='/pay/app/businessos/r11/authorize/'+ID;
function post(s,token,csrf,fields={}){
 return fetch(s.url+url,{method:'POST',redirect:'manual',headers:{
  'Content-Type':'application/x-www-form-urlencoded',
  ...(token?{Cookie:'kashbit_web_session='+token}:{})
 },body:new URLSearchParams({_csrf:csrf,consent:'yes',...fields})});
}
function get(s,token){
 return fetch(s.url+url,{redirect:'manual',
  headers:token?{Cookie:'kashbit_web_session='+token}:{}});
}
test('H4 route is not mounted unless explicitly enabled',async()=>{
 const f=fixture({fenced:false}),s=await serve(f.app);
 try{
  assert.equal((await get(s,f.p.token)).status,404);
  assert.equal((await post(s,f.p.token,f.payer.csrf)).status,404);
  assert.equal(f.seen.length,0);
 }finally{await s.close();}
});
test('H4 guest and unrelated account cannot read or post an R11 handoff',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  assert.equal((await get(s)).status,303);
  assert.equal((await post(s,null,'random')).status,303);
  assert.equal((await get(s,f.q.token)).status,404);
  assert.equal((await post(s,f.q.token,f.attacker.csrf)).status,404);
  assert.equal(f.seen.length,0);
 }finally{await s.close();}
});
test('H4 authenticated payer sees only amount; CSRF and consent required',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  const response=await get(s,f.p.token);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/\$12\.75 MXN/);
  assert.match(html,/Pago no confirmado|Autorización no equivale/);
  assert.equal((await post(s,f.p.token,'incorrect')).status,403);
  assert.equal((await post(s,f.p.token,f.payer.csrf,{consent:'no'})).status,403);
  assert.equal(f.seen.length,0);
 }finally{await s.close();}
});
test('H4 browser financial fields never control the injected R11 flow',async()=>{
 const f=fixture(),s=await serve(f.app);
 try{
  const response=await post(s,f.p.token,f.payer.csrf,{
   tenantId:'other-tenant',accountId:f.attacker.accountId,
   paymentMethodReference:'foreign-card',fraudDecision:'APPROVE',
   delegatedBearer:'forged',amount:'999999',csrfVerified:'true'
  });
  assert.equal(response.status,202);
  const html=await response.text();
  assert.match(html,/pendiente de captura/);
  assert.doesNotMatch(html,/Pago completado|forged/);
  assert.deepEqual(f.seen,[{requestId:ID,accountId:f.payer.accountId,
   consent:true,csrfVerified:true}]);
 }finally{await s.close();}
});
test('H4 stale/unknown source never invokes authorization',async()=>{
 const f=fixture({sourceFails:true}),s=await serve(f.app);
 try{
  assert.equal((await post(s,f.p.token,f.payer.csrf)).status,404);
  assert.equal(f.seen.length,0);
 }finally{await s.close();}
});
test('H4 UNKNOWN remains HOLD and may not announce PAID',async()=>{
 const f=fixture({flowResult:'UNKNOWN_HOLD_NO_AUTO_RETRY'}),s=await serve(f.app);
 try{
  const r=await post(s,f.p.token,f.payer.csrf);
  assert.equal(r.status,202);
  assert.match(await r.text(),/No repitas/);
  assert.equal(f.seen.length,1);
 }finally{await s.close();}
});
test('H4 mutually exclusive with direct saved-card/legacy R2 financial paths',()=>{
 const f=fixture({fenced:false});
 assert.throws(()=>createAccountRouter({service:f.service,savedCardEnabled:true,
  businessosFencedAuthorization:{isEnabled:true,authorizeOnce:async()=>({})},
  businessosFencedRequestStore:f.requestStore}),/R11_AUTHENTICATED_ROUTE_FINANCIAL_CONFLICT/);
 assert.throws(()=>createAccountRouter({service:f.service,savedCardEnabled:false,
  businessosFlow:{isEnabled:true},businessosFencedAuthorization:{isEnabled:true,authorizeOnce:async()=>({})},
  businessosFencedRequestStore:f.requestStore}),/R11_AUTHENTICATED_ROUTE_FINANCIAL_CONFLICT/);
});
