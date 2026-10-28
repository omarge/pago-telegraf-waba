'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createPayerClaimLedger}=require('../src/businessosPayerClaimLedger');
const {createAccountService}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createFormApp}=require('../src/formServer');
const {createVault}=require('../src/cardVault');
const {createBusinessosChannelFlow}=require('../src/businessosChannelFlow');
const {createBusinessosAuthorizationAdapter}=require('../src/businessosAuthorizationAdapter');
const REQUEST='KPR-'+'C'.repeat(32);
const KEY='offline-integration-key-only-r3-32-chars-minimum';
function fixture({clock=()=>Date.now(),bound=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'waba-r3-'));
 const filePath=path.join(root,'claim-ledger','private.json');
 const original={id:REQUEST,amount:1250,state:'PENDING',requesterId:'5215555550002',
  ...(bound?{payerAccountId:'old-payer'}:{})};
 const requestStore={getRequest:id=>id===REQUEST?original:null};
 const build=()=>createPayerClaimLedger({filePath,integrityKey:KEY,
  requestStore,now:clock});
 const close=()=>fs.rmSync(root,{recursive:true,force:true});
 return {root,filePath,original,requestStore,build,close};
}
test('R3 issue secret is single-use, hashed on disk, and file is private',()=>{
 const f=fixture(),l=f.build();
 try{
  const grant=l.issue({requestId:REQUEST});
  assert.equal(grant.state,'ISSUED');
  assert.ok(grant.claimSecret.length>=30);
  assert.equal(l.issue({requestId:REQUEST}).state,'ALREADY_ISSUED');
  const data=fs.readFileSync(f.filePath,'utf8');
  assert.ok(!data.includes(grant.claimSecret));
  assert.equal(fs.statSync(f.filePath).mode&0o077,0);
  assert.equal(fs.statSync(path.dirname(f.filePath)).mode&0o077,0);
  assert.deepEqual(l.claim({
   requestId:REQUEST,claimSecret:grant.claimSecret,accountId:'payer-account',
   csrfVerified:true,whatsappLinked:true
  }),{state:'CLAIMED'});
  assert.equal(l.bindingFor(REQUEST),'payer-account');
  assert.equal(l.getRequest(REQUEST).payerAccountId,'payer-account');
  assert.equal(f.original.payerAccountId,undefined);
  assert.equal(l.issue({requestId:REQUEST}).state,'ALREADY_CLAIMED');
  assert.equal(l.claim({
   requestId:REQUEST,claimSecret:grant.claimSecret,accountId:'attacker',
   csrfVerified:true,whatsappLinked:true
  }).state,'ALREADY_CLAIMED');
 }finally{l.close();f.close();}
});
test('R3 binding survives restart and second writer is denied',()=>{
 const f=fixture();
 try{
  const l=f.build();
  const secret=l.issue({requestId:REQUEST}).claimSecret;
  assert.throws(()=>f.build(),/R3_WRITER_LOCKED/);
  l.claim({requestId:REQUEST,claimSecret:secret,accountId:'payer1',
   csrfVerified:true,whatsappLinked:true});
  l.close();
  const recovered=f.build();
  try{assert.equal(recovered.bindingFor(REQUEST),'payer1');}
  finally{recovered.close();}
 }finally{f.close();}
});
test('R3 unauthenticated, wrong secret, absent CSRF and unlinked WhatsApp fail closed',()=>{
 const f=fixture(),l=f.build();
 try{
  const grant=l.issue({requestId:REQUEST});
  for(const attempt of [
   {claimSecret:grant.claimSecret,accountId:'payer',csrfVerified:false,whatsappLinked:true},
   {claimSecret:grant.claimSecret,accountId:'payer',csrfVerified:true,whatsappLinked:false},
   {claimSecret:'invalid-00000000000000000000000000000000000000',accountId:'payer',csrfVerified:true,whatsappLinked:true},
   {claimSecret:grant.claimSecret,accountId:'',csrfVerified:true,whatsappLinked:true}
  ]){
   assert.equal(l.claim({requestId:REQUEST,...attempt}).state,'DENIED');
  }
  assert.equal(l.bindingFor(REQUEST),null);
  assert.equal(l.claim({requestId:REQUEST,claimSecret:grant.claimSecret,
   accountId:'payer',csrfVerified:true,whatsappLinked:true}).state,'CLAIMED');
 }finally{l.close();f.close();}
});
test('R3 claim expired after 15min and server can reissue a different secret',()=>{
 let clock=1800000000000;
 const f=fixture({clock:()=>clock}),l=f.build();
 try{
  const first=l.issue({requestId:REQUEST});
  clock+=15*60*1000+1;
  assert.equal(l.claim({requestId:REQUEST,claimSecret:first.claimSecret,
   accountId:'payer',csrfVerified:true,whatsappLinked:true}).state,'EXPIRED');
  const second=l.issue({requestId:REQUEST});
  assert.equal(second.state,'ISSUED');
  assert.notEqual(first.claimSecret,second.claimSecret);
  assert.equal(l.claim({requestId:REQUEST,claimSecret:first.claimSecret,
   accountId:'payer',csrfVerified:true,whatsappLinked:true}).state,'DENIED');
 }finally{l.close();f.close();}
});
test('R3 claim cannot be issued for already owner-assigned, missing or paid request',()=>{
 const f=fixture(),l=f.build();
 try{
  assert.equal(l.issue({requestId:'KPR-'+('D'.repeat(32))}).state,'NOT_FOUND');
  f.original.state='PAID';
  assert.equal(l.issue({requestId:REQUEST}).state,'NOT_FOUND');
  f.original.state='PENDING';
  f.original.payerAccountId='old-account';
  assert.equal(l.issue({requestId:REQUEST}).state,'NOT_FOUND');
 }finally{l.close();f.close();}
});
test('R3 amount or original requester changes invalidate grant and bound view',()=>{
 const f=fixture(),l=f.build();
 try{
  const secret=l.issue({requestId:REQUEST}).claimSecret;
  f.original.amount=50000;
  assert.equal(l.claim({requestId:REQUEST,claimSecret:secret,
   accountId:'payer',csrfVerified:true,whatsappLinked:true}).state,'REQUEST_CHANGED');
  f.original.amount=1250;
  assert.equal(l.claim({requestId:REQUEST,claimSecret:secret,
   accountId:'payer',csrfVerified:true,whatsappLinked:true}).state,'CLAIMED');
  assert.equal(l.bindingFor(REQUEST),'payer');
  f.original.requesterId='attacker-new-requester';
  assert.equal(l.bindingFor(REQUEST),null);
  assert.equal(l.getRequest(REQUEST).payerAccountId,null);
  f.original.requesterId='5215555550002';
  f.original.state='UNKNOWN_SAVED_CARD';
  assert.equal(l.bindingFor(REQUEST),null);
 }finally{l.close();f.close();}
});
test('R3 missing original request after restart cannot authorize from orphaned claim',()=>{
 const f=fixture(),l=f.build();
 try{
  const secret=l.issue({requestId:REQUEST}).claimSecret;
  l.claim({requestId:REQUEST,claimSecret:secret,accountId:'payer',
   csrfVerified:true,whatsappLinked:true});
  l.close();
  const previous=f.requestStore.getRequest;
  f.requestStore.getRequest=()=>null;
  const recovered=f.build();
  try{
   assert.equal(recovered.bindingFor(REQUEST),null);
   assert.equal(recovered.getRequest(REQUEST),null);
  }finally{recovered.close();f.requestStore.getRequest=previous;}
 }finally{f.close();}
});
test('R3 ledger file alteration fails closed with HMAC integrity error',()=>{
 const f=fixture(),l=f.build();
 try{
  const grant=l.issue({requestId:REQUEST});
  l.close();
  const raw=fs.readFileSync(f.filePath,'utf8');
  fs.writeFileSync(f.filePath,raw.replace('1250','9999'),{mode:0o600});
  assert.throws(()=>f.build(),/R3_FILE_INTEGRITY/);
  assert.ok(!fs.existsSync(f.filePath+'.lock'));
  assert.ok(grant.claimSecret.length>0);
 }finally{f.close();}
});
test('R3 existing unsafe ledger permissions cause recovery refusal',()=>{
 const f=fixture(),l=f.build();
 try{
  l.issue({requestId:REQUEST});
  l.close();
  fs.chmodSync(f.filePath,0o644);
  assert.throws(()=>f.build(),/R3_FILE_UNSAFE/);
 }finally{f.close();}
});
async function start(app){
 const s=await new Promise(resolve=>{const n=app.listen(0,'127.0.0.1',()=>resolve(n));});
 return {url:'http://127.0.0.1:'+s.address().port,
  close:()=>new Promise(resolve=>s.close(resolve))};
}
function httpFixture(){
 const f=fixture(),l=f.build(),accounts=createAccountService({filePath:null});
 const ps=accounts.register('r3payer@example.com','r3-payer-password-1234');
 const os=accounts.register('r3outsider@example.com','r3-outsider-password-1234');
 const payer=accounts.getSession(ps.token),outsider=accounts.getSession(os.token);
 const challenge=accounts.beginLink(ps.token,payer.csrf);
 assert.equal(accounts.bindFromWhatsApp('5215555550001',challenge.code),true);
 let calls=0;
 const adapter=createBusinessosAuthorizationAdapter({enabled:true,transport:async input=>{
  calls++;
  assert.equal(input.body.amount,'12.50');
  return {httpStatus:200,body:{tenantId:'tenant-r3',
   paymentIntentId:'int-r3-id',paymentAttemptId:'att-r3-id',status:'AUTHORIZED'}};
 }});
 const flow=createBusinessosChannelFlow({enabled:true,requestStore:l,
  resolveTrustedAuthority:async({accountId})=>({
   accountId,tenantId:'tenant-r3',customerId:'customer-r3',
   paymentMethodReferenceProvider:'OPENPAY',paymentMethodReference:'vault-r3',
   delegatedBearer:'r3-delegated-token-only-for-offline-test',
   fraudAssessmentId:'fraud-r3',fraudDecision:'APPROVE',clientIpAddress:'127.0.0.1'
  }),adapter});
 const app=createFormApp({accountRouter:createAccountRouter({
  service:accounts,requestStore:l,vault:createVault({filePath:null}),
  businessosClaims:l,businessosFlow:flow,savedCardEnabled:false
 }),charge:async()=>{throw Error('no PSP in R3');}});
 return {f,l,ps,os,payer,outsider,accounts,app,getCalls:()=>calls};
}
function post(s,route,token,fields){
 return fetch(s.url+'/pay/app'+route,{method:'POST',redirect:'manual',
  headers:{'Content-Type':'application/x-www-form-urlencoded',
   Cookie:'kashbit_web_session='+token},
  body:new URLSearchParams(fields)
 });
}
test('R3 HTTP claim requires linked session, CSRF, single-use code and prevents hijack',async()=>{
 const f=httpFixture(),s=await start(f.app);
 try{
  const secret=f.l.issue({requestId:REQUEST}).claimSecret;
  const claimRoute='/businessos/claim/'+REQUEST;
  const authRoute='/businessos/authorize/'+REQUEST;
  let r=await post(s,claimRoute,f.os.token,{
   _csrf:f.outsider.csrf,claimSecret:secret,consent:'yes'});
  assert.equal(r.status,403);
  r=await post(s,claimRoute,f.ps.token,{
   _csrf:'forged',claimSecret:secret,consent:'yes'});
  assert.equal(r.status,403);
  assert.equal(f.getCalls(),0);
  r=await post(s,authRoute,f.ps.token,{_csrf:f.payer.csrf,consent:'yes'});
  assert.equal(r.status,404);
  r=await post(s,claimRoute,f.ps.token,{
   _csrf:f.payer.csrf,claimSecret:'fake-code-fake-code-fake-code-fake-code',consent:'yes'});
  assert.equal(r.status,403);
  r=await post(s,claimRoute,f.ps.token,{
   _csrf:f.payer.csrf,claimSecret:secret,consent:'yes'});
  assert.equal(r.status,200);
  assert.match(await r.text(),/Pago no realizado/);
  assert.equal(f.l.bindingFor(REQUEST),f.payer.accountId);
  r=await post(s,claimRoute,f.os.token,{
   _csrf:f.outsider.csrf,claimSecret:secret,consent:'yes'});
  assert.equal(r.status,403);
  r=await post(s,authRoute,f.ps.token,{
   _csrf:f.payer.csrf,consent:'yes',amount:'999999',tenantId:'attacker'});
  assert.equal(r.status,202);
  assert.match(await r.text(),/Pago no confirmado/);
  assert.equal(f.getCalls(),1);
  r=await post(s,authRoute,f.os.token,{_csrf:f.outsider.csrf,consent:'yes'});
  assert.equal(r.status,404);
  assert.equal(f.getCalls(),1);
 }finally{await s.close();f.l.close();f.f.close();}
});
test('R3 opt-in claim route never mounted by default',async()=>{
 const f=fixture(),l=f.build(),accounts=createAccountService({filePath:null});
 const sess=accounts.register('default-r3@example.com','default-pass-r3-1234');
 const app=createFormApp({accountRouter:createAccountRouter({
  service:accounts,requestStore:l,vault:createVault({filePath:null}),
  savedCardEnabled:false
 })});
 const s=await start(app);
 try{
  const r=await post(s,'/businessos/claim/'+REQUEST,sess.token,{
   _csrf:accounts.getSession(sess.token).csrf,claimSecret:'none',consent:'yes'});
  assert.equal(r.status,404);
 }finally{await s.close();l.close();f.close();}
});
