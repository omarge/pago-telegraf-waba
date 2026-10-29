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
function fake(log,{badAcl=false,missingTopic=false,groupAclError=false,emptyGroup=false,wrongTopicScope=false,wrongGroupScope=false,connectFail=false}={}){
 return function Kafka(config){
  log.settings=config;
  return {consumer(){throw Error('CONSUMER_FORBIDDEN');},
   producer(){throw Error('PRODUCER_FORBIDDEN');},
   admin(){log.adminCreated++;
    return {
     async connect(){log.connected++;if(connectFail)throw Error('PRIVATE-CONNECTION-CREDENTIAL-NEVER-PRINT');},
     async fetchTopicMetadata({topics}){
      assert.deepEqual(topics,['businessos.payment.events.v1']);
      log.metadata++;
      return {topics:missingTopic?[]:[{name:topics[0],partitions:[{partitionId:0}]}]};
     },
     async describeAcls(args){
      log.aclArgs.push(args);log.acls++;
      if(badAcl||(groupAclError&&args.resourceType===3))
       throw Error('BROKER_NO_AUTHORIZATION_PRIVATE_DETAILS');
      return {resources:emptyGroup&&args.resourceType===3?[]:[
       {resourceName:(args.resourceType===2&&wrongTopicScope)||
        (args.resourceType===3&&wrongGroupScope)?'foreign-resource':args.resourceName,
        resourceType:args.resourceType,acls:[{}]}
      ]};
     },
     async disconnect(){log.disconnected++;}
    };
   }};
 };
}
function counts(){return {adminCreated:0,connected:0,metadata:0,acls:0,
 disconnected:0,settings:null,aclArgs:[]};}
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
 assert.equal(l.acls,2);assert.equal(l.disconnected,1);
 assert.deepEqual(l.aclArgs.map(x=>x.resourceType),[2,3]);
 assert.deepEqual(l.aclArgs.map(x=>x.resourceName),
  ['businessos.payment.events.v1','waba-r14-security']);
 assert.equal(out.topicAclDescriptionReturned,true);
 assert.equal(out.groupAclDescriptionReturned,true);
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

test('R15 topic ACL exists but GROUP permission lookup fails, always HOLD',async()=>{
 const l=counts();
 const p=createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:cfg(),kafkaFactory:fake(l,{groupAclError:true})});
 const out=await p.inspect();
 assert.equal(out.state,'GROUP_ACL_INSPECTION_UNAVAILABLE_HOLD');
 assert.equal(l.acls,2);
 assert.equal(l.disconnected,1);
 assert.equal(out.isBrokerCertified,false);
 assert.equal(out.mayConsumeMessages,false);
 assert.equal(JSON.stringify(out).includes('waba-r14-security'),false);
});
test('R15 empty group ACL must not be mistaken for an authenticated policy',async()=>{
 const l=counts();
 const out=await createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:cfg(),kafkaFactory:fake(l,{emptyGroup:true})}).inspect();
 assert.equal(out.state,'ACL_POLICY_EMPTY_HOLD');
 assert.equal(l.acls,2);
 assert.equal(out.productionGo,false);
 assert.equal(l.disconnected,1);
});
test('R15 malformed custom CA must stop before any network connection',async()=>{
 const l=counts();
 const out=await createR14SecuredKafkaReadOnlyProbe({enabled:true,
  config:{...cfg(),tlsCaPem:['invalid-ca']},
  kafkaFactory:fake(l)}).inspect();
 assert.equal(out.state,'CONFIG_REJECTED_NO_NETWORK');
 assert.equal(l.adminCreated,0);
 assert.equal(out.isBrokerCertified,false);
});

test('R16 nonempty ACL for a foreign topic is not accepted as policy evidence',async()=>{
 const log=counts();
 const observed=await createR14SecuredKafkaReadOnlyProbe({
  enabled:true,config:cfg(),kafkaFactory:fake(log,{wrongTopicScope:true})
 }).inspect();
 assert.equal(observed.state,'ACL_RESOURCE_SCOPE_NOT_PROVEN_HOLD');
 assert.equal(observed.isAclCertified,false);
 assert.equal(observed.productionGo,false);
 assert.equal(log.disconnected,1);
});
test('R16 nonempty ACL for another group never attests our consumer group',async()=>{
 const log=counts();
 const observed=await createR14SecuredKafkaReadOnlyProbe({
  enabled:true,config:cfg(),kafkaFactory:fake(log,{wrongGroupScope:true})
 }).inspect();
 assert.equal(observed.state,'ACL_RESOURCE_SCOPE_NOT_PROVEN_HOLD');
 assert.equal(log.acls,2);
 assert.equal(observed.mayConsumeMessages,false);
 assert.equal(log.disconnected,1);
});
test('R16 failed Kafka admin connect disconnects partially allocated resources',async()=>{
 const log=counts();
 const observed=await createR14SecuredKafkaReadOnlyProbe({
  enabled:true,config:cfg(),kafkaFactory:fake(log,{connectFail:true})
 }).inspect();
 assert.equal(observed.state,'BROKER_CONNECT_OR_METADATA_HOLD');
 assert.equal(log.connected,1);
 assert.equal(log.disconnected,1);
 assert.equal(log.metadata,0);
 assert.equal(observed.productionGo,false);
 assert.equal(JSON.stringify(observed).includes('PRIVATE-CONNECTION-CREDENTIAL'),false);
});
