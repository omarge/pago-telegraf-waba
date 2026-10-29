'use strict';
// Explicit, operator-initiated, READ-ONLY Kafka metadata inspection.
// Never loaded by WABA startup. Never reads .env, publishes, subscribes,
// consumes messages, commits offsets, or prints secrets or broker details.
const {createR14SecuredKafkaReadOnlyProbe}=
 require('../src/businessosR14SecuredKafkaReadOnlyProbe');
async function main(){
 const enabled=process.env.R14_KAFKA_PROBE_ENABLED==='1';
 const config={
  topic:'businessos.payment.events.v1',
  brokers:(process.env.R14_KAFKA_BROKERS||'').split(',').filter(Boolean),
  clientId:process.env.R14_KAFKA_CLIENT_ID||'r14-readonly-probe',
  groupId:process.env.R14_KAFKA_GROUP_ID||'r14-readonly-probe-group',
  username:process.env.R14_KAFKA_USERNAME||'',
  password:process.env.R14_KAFKA_PASSWORD||'',
  tlsCaPem:process.env.R14_KAFKA_CA_PEM?[process.env.R14_KAFKA_CA_PEM]:undefined
 };
 const gate=createR14SecuredKafkaReadOnlyProbe({enabled,config});
 const observed=await gate.inspect();
 process.stdout.write(JSON.stringify(observed)+'\n');
 // Metadata observation is never authorization to start WABA or send a receipt.
 process.exitCode=observed.state==='DISABLED_NO_NETWORK'?0:2;
}
main().catch(()=>{
 process.stdout.write('{"state":"PROBE_UNEXPECTED_ERROR_HOLD","productionGo":false}\n');
 process.exitCode=2;
});
