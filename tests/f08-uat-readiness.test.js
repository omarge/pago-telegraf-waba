'use strict';
// F08 public UAT preflight: the historical /pay/charge endpoint must fail
// closed unless explicitly opted in by a LOCAL, isolated test fixture.
// No real Openpay or WhatsApp requests are made.
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createFormApp}=require('../src/formServer');
async function server(app){
 const s=await new Promise(resolve=>{
  const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));
 });
 return {url:'http://127.0.0.1:'+s.address().port,
  close:()=>new Promise(resolve=>s.close(resolve))};
}
test('F08 RED-first: default public token charge is disabled even if PSP keys exist',async()=>{
 const requests=[];
 const app=createFormApp({accountRouter:express.Router(),
  merchant:'merchant-f08-fake',privateKey:'fake-key',
  charge:async(...args)=>{requests.push(args);return {id:'charge-fake',status:'completed'};},
  messenger:{sendMessage:async()=>{throw Error('forbidden notification');}}
 });
 const s=await server(app);
 try{
  const r=await fetch(s.url+'/pay/charge',{method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({token_id:'fake-token',amount:999999,
    request_id:'KPR-'+('A'.repeat(32)),requester_id:'5215555550001'})});
  assert.equal(r.status,404);
  assert.deepEqual(requests,[]);
  assert.doesNotMatch(await r.text(),/fake-token|fake-key|999999/);
 }finally{await s.close();}
});
test('F08 isolated opt-in keeps existing historical offline route semantics ONLY for fake PSP regression',async()=>{
 const calls=[],notices=[];
 const app=createFormApp({accountRouter:express.Router(),
  merchant:'f08-fake-merchant',privateKey:'f08-fake-key',
  legacyChargeEnabled:true,
  charge:async(...a)=>{calls.push(a);return {id:'f08-fake-charge',status:'completed'};},
  messenger:{sendMessage:async(...a)=>notices.push(a)}
 });
 const s=await server(app);
 try{
  const r=await fetch(s.url+'/pay/charge',{method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({token_id:'fake-one-time-token',amount:1000,holder:'F08 Mock',
    request_id:'KPR-'+('B'.repeat(32)),requester_id:'5215555550001'})});
  assert.equal(r.status,200);
  assert.equal((await r.json()).charge_id,'f08-fake-charge');
  assert.equal(calls.length,1);
  assert.equal(notices.length,1);
 }finally{await s.close();}
});
test('F08 all auth microapps still redirect without session (no public data leak)',async()=>{
 const {createAccountRouter}=require('../src/accountRoutes');
 const {createAccountService}=require('../src/accountService');
 const {createVault}=require('../src/cardVault');
 const accountRouter=createAccountRouter({service:createAccountService({filePath:null}),
  vault:createVault({filePath:null}),requestStore:{getRequest:()=>null}});
 const s=await server(createFormApp({accountRouter,charge:async()=>{throw Error('not allowed');}}));
 try{
  for(const route of ['/pay/app/cards','/pay/app/pin','/pay/app/settings',
   '/pay/app/statement','/pay/app/receipts']){
   const r=await fetch(s.url+route,{redirect:'manual'});
   assert.equal(r.status,303,route);
   assert.match(r.headers.get('location'),/\/pay\/app\/login/);
  }
  assert.equal((await fetch(s.url+'/healthz')).status,200);
 }finally{await s.close();}
});

test('F08 safe default checkout does not offer legacy PAN/CVV form or token charge',async()=>{
 const app=createFormApp({accountRouter:express.Router(),
  merchant:'fake-merchant',privateKey:'fake-psp-key',
  showSavedCardOption:true,
  paymentStore:{
   consumeInvite:()=>({requesterId:'5215555550001',amount:1000}),
   createRequest:()=>({id:'KPR-'+('A'.repeat(32))})
  },
  charge:async()=>{throw Error('must not charge');}
 });
 const s=await server(app);
 try{
  const r=await fetch(s.url+'/pay/request/f08-offline',{redirect:'manual'});
  assert.equal(r.status,200);
  const html=await r.text();
  assert.match(html,/Pagar con tarjeta guardada/);
  assert.match(html,/\$10.00 MXN/);
  assert.doesNotMatch(html,/<form id="payment"|\/pay\/charge|id="pan"|id="cvv"/);
 }finally{await s.close();}
});
