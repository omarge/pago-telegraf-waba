'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createR12RebalanceFencedConsumer}=
 require('../src/businessosR12RebalanceFencedConsumer');
const {createR12SecuredKafkaConsumer}=
 require('../src/businessosR12SecuredKafkaConsumer');
const config={topic:'businessos.payment.events.v1',brokers:['broker.ci.invalid:9093'],
 clientId:'r12f-transport-fence',groupId:'r12f-test-group',
 username:'r12f-user',password:'not-a-production-secret-123456789'};
function stubPool(){
 let calls=0;
 return {pool:{connect:async()=>{calls++;throw Error('DB MUST STAY DARK');},
  query:async()=>{calls++;throw Error('DB MUST STAY DARK');}},
  get calls(){return calls;}};
}
function stubFactory(stats){
 return function FakeTransport(settings){
  stats.settings=settings;
  return {consumer:()=>({
   connect:async()=>{stats.connects++;},subscribe:async()=>{},
   run:async()=>{},stop:async()=>{},disconnect:async()=>{},
   commitOffsets:async()=>{throw Error('NO ACK IN TEST')}
  })};
 };
}
test('R12-F constructor override refused in ordinary node process before network',()=>{
 const source=[
 "const {createR12RebalanceFencedConsumer}=require('./src/businessosR12RebalanceFencedConsumer');",
 "const {createR12SecuredKafkaConsumer}=require('./src/businessosR12SecuredKafkaConsumer');",
 "const config={topic:'businessos.payment.events.v1',brokers:['secure.invalid:9093'],",
 "clientId:'r12f-sandbox',groupId:'r12f-sandbox-group',",
 "username:'sandbox-username',password:'not-a-live-secret-123456789'};",
 "let contacted=0;",
 "function Fake(){contacted++;throw Error('bypass constructor used');}",
 "const pool={connect:async()=>{contacted++;throw Error('DB used')},",
 "query:async()=>{contacted++;throw Error('DB used')}};",
 "(async()=>{",
 "const a=createR12RebalanceFencedConsumer({enabled:true,config,pool,kafkaFactory:Fake});",
 "const b=createR12SecuredKafkaConsumer({enabled:true,config,pool,kafkaFactory:Fake});",
 "const values=[await a.start(),await b.start()];",
 "process.stdout.write(JSON.stringify({values,contacted,context:process.env.NODE_TEST_CONTEXT||''}));",
 "})().catch(e=>{console.error(e);process.exitCode=7;});"
 ].join('\n');
 const out=spawnSync(process.execPath,['-e',source],{
  cwd:process.cwd(),encoding:'utf8',timeout:9000,
  env:{...process.env,NODE_TEST_CONTEXT:''}
 });
 assert.equal(out.status,0,out.stderr);
 const data=JSON.parse(out.stdout);
 assert.equal(data.contacted,0);
 assert.equal(data.context,'');
 for(const v of data.values)assert.deepEqual(v,
  {state:'TEST_TRANSPORT_OVERRIDE_REJECTED_NO_CONNECT'});
});
test('R12-F node:test fake still exercises TLS+SCRAM config, without network',async()=>{
 assert.ok(['child-v8','child-process'].includes(process.env.NODE_TEST_CONTEXT));
 for(const create of [createR12RebalanceFencedConsumer,createR12SecuredKafkaConsumer]){
  const tracker={connects:0,settings:null},p=stubPool();
  const c=create({enabled:true,pool:p.pool,config,kafkaFactory:stubFactory(tracker)});
  const result=await c.start();
  assert.match(result.state,/CONSUMER_STARTED_/);
  assert.equal(tracker.connects,1);
  assert.equal(tracker.settings.ssl.rejectUnauthorized,true);
  assert.equal(tracker.settings.sasl.mechanism,'scram-sha-512');
  assert.equal(p.calls,0);
  await c.stop();
 }
});
test('R12-F disabled mode never reaches injected fake',async()=>{
 const p=stubPool(),tracker={connects:0,settings:null};
 const c=createR12RebalanceFencedConsumer({pool:p.pool,config,kafkaFactory:stubFactory(tracker)});
 assert.deepEqual(await c.start(),{state:'DISABLED'});
 assert.equal(tracker.connects,0);
 assert.equal(p.calls,0);
});
