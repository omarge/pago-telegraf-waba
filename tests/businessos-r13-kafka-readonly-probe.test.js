'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createR14SecuredKafkaReadOnlyProbe}=
 require('../src/businessosR14SecuredKafkaReadOnlyProbe');
const cfg=()=>({
 topic:'businessos.payment.events.v1',
 brokers:['broker.offline.invalid:9093'],clientId:'waba-r14-probe',
 groupId:'waba-r14-security',username:'r14-readonly-user',
 password:'fake-test-secret-not-a-live-credential-1234',
 tlsCaPem:['-----BEGIN CERTIFICATE-----\nTEST-ONLY\n-----END CERTIFICATE-----']
});
function fake(log,{badAcl=false,missingTopic=false}={}){
 return function Kafka(config){
  log.settings=config;
  return {consumer(){throw Error('CONSUMER_FORBIDDEN');},
   producer(){throw Error('PRODUCER_FORBIDDEN');},
   admin(){log.adminCreated++;
    return {
     async connect(){log.connected++;},
     async fetchTopicMetadata({topics}){
      assert.deepEqual(topics,['businessos.payment.events.v1']);
      log.metadata++;
      return {topics:missingTopic?[]:[{name:topics[0],partitions:[{partitionId:0}]}]};
     },
     async describeAcls(args){
      log.aclArgs=args;log.acls++;
      if(badAcl)throw Error('BROKER_NO_AUTHORIZATION_PRIVATE_DETAILS');
      return {resources:[]};
     },
     async disconnect(){log.disconnected++;}
    };
   }};
 };
}
function counts(){return {adminCreated:0,connected:0,metadata:0,acls:0,
 disconnected:0,settings:null};}
test('R14 probe disabled is network-dark with no dependencies',async()=>{
 const l=counts();
 const p=createR14SecuredKafkaReadOnlyProbe({enabled:false,
  config:cfg(),kafkaFactory:fake(l)});
 const out=await p.inspect();
 assert.equal(out.state,'DISABLED_NO_NETWORK');
 assert.equal(l.adminCreated,0);
 assert.equal(out.isPaid,false);assert.equal(out.mayConsumeMessages,false);
});
test('R14 genuine metadata/ACL-shaped test observation is never certification',async()=>{
 const l=counts(),p=createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:cfg(),kafkaFactory:fake(l)});
 const out=await p.inspect();
 assert.equal(out.state,'BROKER_METADATA_OBSERVED_PENDING_INDEPENDENT_AUDIT');
 assert.equal(out.partitionCount,1);
 assert.equal(l.connected,1);assert.equal(l.metadata,1);
 assert.equal(l.acls,1);assert.equal(l.disconnected,1);
 assert.equal(l.settings.ssl.rejectUnauthorized,true);
 assert.equal(l.settings.sasl.mechanism,'scram-sha-512');
 for(const key of ['isBrokerCertified','isAclCertified','isPaid',
  'canSendReceipt','mayConsumeMessages','mayCommitOffsets','productionGo'])
  assert.equal(out[key],false,key);
 assert.equal(JSON.stringify(out).includes('fake-test-secret'),false);
});
test('R14 ACL listing refused is HOLD even with valid secured topic',async()=>{
 const l=counts(),p=createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:cfg(),kafkaFactory:fake(l,{badAcl:true})});
 const out=await p.inspect();
 assert.equal(out.state,'ACL_INSPECTION_UNAVAILABLE_HOLD');
 assert.equal(l.disconnected,1);
 assert.equal(out.isAclCertified,false);
});
test('R14 missing topic and invalid broker config fail-closed without sends',async()=>{
 const l=counts();
 const missing=createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:cfg(),kafkaFactory:fake(l,{missingTopic:true})});
 assert.equal((await missing.inspect()).state,'TOPIC_NOT_FOUND_HOLD');
 assert.equal(l.disconnected,1);
 const bad=createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:{...cfg(),topic:'malicious.topic'},kafkaFactory:fake(l)});
 assert.equal((await bad.inspect()).state,'CONFIG_REJECTED_NO_NETWORK');
 assert.equal(l.adminCreated,1);
});
test('R14 credentials are never copied into failed connection output',async()=>{
 const l=counts(),transport=function Kafka(){
  return {admin(){return {async connect(){throw Error('SECRET-MUST-NOT-LEAK');},
   async disconnect(){throw Error('NOT_CONNECTED');}};}};
 };
 const out=await createR14SecuredKafkaReadOnlyProbe({
  enabled:true,config:cfg(),kafkaFactory:transport}).inspect();
 assert.equal(out.state,'BROKER_CONNECT_OR_METADATA_HOLD');
 assert.equal(JSON.stringify(out).includes('SECRET'),false);
});
