'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const store=require('../src/store');
test('R33-B invitation tokens have 192 bits and one winner per process',async()=>{const token=store.createInvite('user-test-r33',1000);assert.match(token,/^[A-Za-z0-9_-]{32}$/);const results=await Promise.all(Array.from({length:32},async()=>store.consumeInvite(token)));assert.equal(results.filter(Boolean).length,1);assert.deepEqual(results.find(Boolean).amount,1000);assert.equal(store.consumeInvite(token),null)});
test('R33-B random invitation tokens are not reused in bounded sample',()=>{const s=new Set(Array.from({length:128},()=>store.createInvite('user-test-r33',1000)));assert.equal(s.size,128)});
