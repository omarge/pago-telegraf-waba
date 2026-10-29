'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {durableMode,createDurableIngress}=require('../src/businessosDurableIngressBootstrap');
test('R28-A explicit strict policy refuses legacy ACK fallback',async()=>{
 for(const flag of [undefined,'','0']){
  const env={WABA_BUSINESSOS_REQUIRE_DURABLE_WEBHOOK:'1'};
  if(flag!==undefined)env.WABA_BUSINESSOS_DURABLE_WEBHOOK=flag;
  assert.throws(()=>durableMode(env),/WABA_DURABLE_INGRESS_REQUIRED/);
  await assert.rejects(()=>createDurableIngress({env}),/WABA_DURABLE_INGRESS_REQUIRED/);
 }
});
test('R28-A strict ingress fails closed on missing credentials before listener',async()=>{
 const env={WABA_BUSINESSOS_REQUIRE_DURABLE_WEBHOOK:'1',WABA_BUSINESSOS_DURABLE_WEBHOOK:'1'};
 assert.equal(durableMode(env),true);
 await assert.rejects(()=>createDurableIngress({env}),/WABA_DURABLE_INGRESS_CONFIG_INVALID/);
});
test('R28-A historical optional mode remains unchanged',()=>{
 assert.equal(durableMode({}),false);
 assert.equal(durableMode({WABA_BUSINESSOS_DURABLE_WEBHOOK:'0'}),false);
 assert.equal(durableMode({WABA_BUSINESSOS_DURABLE_WEBHOOK:'1'}),true);
 assert.throws(()=>durableMode({WABA_BUSINESSOS_DURABLE_WEBHOOK:'bad'}),/WABA_DURABLE_INGRESS_MODE_INVALID/);
});
