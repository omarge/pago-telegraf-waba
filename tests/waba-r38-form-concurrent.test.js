'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFormApp}=require('../src/formServer');
const {createServer}=require('node:http');
const express=require('express');
async function get(app,token){const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/pay/request/'+token);return {status:r.status,body:await r.text()}}finally{await new Promise(r=>server.close(r))}}
test('R38 32 concurrent requests to same token render exactly once using claimed boundary',async()=>{
 let claimed=false;let calls=0;
 const app=createFormApp({accountRouter:express.Router(),durableInvitations:{claim:async()=>{calls++;if(claimed)return {state:'NOT_ELIGIBLE_HOLD'};claimed=true;return {state:'CLAIMED',requestId:'KPR-'+'B'.repeat(32),amountCents:1000,requesterId:'521555000001'}}},legacyChargeEnabled:false,showSavedCardOption:false});
 const rs=await Promise.all(Array.from({length:32},()=>get(app,'A'.repeat(32))));
 assert.equal(calls,32);assert.equal(rs.filter(x=>x.status===200).length,1);assert.equal(rs.filter(x=>x.status===404).length,31);
});
test('R38 invalid hold is never silently served as legacy request',async()=>{
 let legacy=0;
 const app=createFormApp({accountRouter:express.Router(),durableInvitations:{claim:async()=>({state:'INVALID_HOLD'})},paymentStore:{consumeInvite:()=>{legacy++;return {requesterId:'x',amount:1000}},createRequest:()=>({id:'legacy'})}});
 const r=await get(app,'B'.repeat(32));assert.equal(r.status,404);assert.equal(legacy,0);
});
