'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assessR13KafkaDeployment}=require('../src/businessosR13KafkaDeploymentPreflight');
const good=()=>({enabled:true,topic:'businessos.payment.events.v1',
 brokers:['broker.test.example:9093'],clientId:'waba-canonical-reader',
 groupId:'waba-canonical-group',ssl:{rejectUnauthorized:true},
 sasl:{mechanism:'scram-sha-512',username:'waba-reader',
 password:'offline-fixture-password-not-live'},
 autoCommit:false,eachBatchAutoResolve:false,allowAutoTopicCreation:false});
test('valid configuration shape never certifies broker or production',()=>{
 const r=assessR13KafkaDeployment(good(),{principal:'waba-reader'});
 assert.equal(r.state,'CONFIG_SHAPE_ONLY');
 assert.deepEqual(r.failures,[]);
 assert.equal(r.mayConnect,false);
 assert.equal(r.productionGo,false);
});
test('insecure transport and automatic offsets fail closed',()=>{
 const x={...good(),ssl:{rejectUnauthorized:false},kafkaFactory:()=>{},
  autoCommit:true,allowAutoTopicCreation:true};
 const r=assessR13KafkaDeployment(x,{principal:'payment-engine'});
 for(const v of ['TLS_VERIFICATION_REQUIRED','TEST_TRANSPORT_FORBIDDEN',
  'MANUAL_OFFSET_REQUIRED','AUTO_TOPIC_CREATION_FORBIDDEN','PRINCIPAL_NOT_PINNED'])
  assert.ok(r.failures.includes(v));
});
test('absent credentials or disabled mode cannot connect',()=>{
 assert.equal(assessR13KafkaDeployment(null).state,'CONFIG_HOLD');
 assert.ok(assessR13KafkaDeployment({...good(),sasl:null}).failures.includes('SCRAM512_REQUIRED'));
 assert.ok(assessR13KafkaDeployment({...good(),enabled:false}).failures.includes('DARK_MODE'));
});
