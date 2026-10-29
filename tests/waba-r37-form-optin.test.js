'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFormApp}=require('../src/formServer');
const {createServer}=require('node:http');
const makeApp=durableInvitations=>createFormApp({durableInvitations,
 accountRouter:require('express').Router(),paymentStore:{consumeInvite(){throw Error('legacy path invoked')}},
 showSavedCardOption:false,legacyChargeEnabled:false});
async function request(app){const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+server.address().port+'/pay/request/'+('A'.repeat(32));const r=await fetch(url);return {status:r.status,body:await r.text()};}finally{await new Promise(resolve=>server.close(resolve))}}
test('R37 durable claim renders only persisted request',async()=>{let n=0;const r=await request(makeApp({claim:async()=>{n++;return {state:'CLAIMED',requestId:'KPR-'+'A'.repeat(32),amountCents:1000,requesterId:'521555000001'}}}));assert.equal(n,1);assert.equal(r.status,200);assert.match(r.body,/10.00/);});
test('R37 database unavailable is fail closed, not legacy fallback',async()=>{const r=await request(makeApp({claim:async()=>({state:'DB_UNAVAILABLE_HOLD'})}));assert.equal(r.status,503)});
test('R37 claim throws, route returns 503',async()=>{const r=await request(makeApp({claim:async()=>{throw Error('database offline')}}));assert.equal(r.status,503)});
test('R37 already consumed invitation is not served',async()=>{const r=await request(makeApp({claim:async()=>({state:'NOT_ELIGIBLE_HOLD'})}));assert.equal(r.status,404)});
