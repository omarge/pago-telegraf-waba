'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {applyTestChannelMigrations}=require('./pgMigrations');
const {createPgSignedInbox}=require('../src/businessosPgSignedInbox');
const {createPgInboxNormalizer}=require('../src/businessosPgInboxNormalizer');
const {createPgRoutingGate}=require('../src/businessosPgRoutingGate');
const {createBusinessosDelegationGate,buildDelegationIntent,validateDelegationDecision}=
 require('../src/businessosSecurityDelegationGate');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
const KEY=crypto.createHash('sha256').update('r7-offline-key-not-production').digest();
const SECRET='meta-r7-offline-secret-123456789012345';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sign=b=>'sha256='+crypto.createHmac('sha256',SECRET).update(b).digest('hex');
const phone='1478834131971433';
function event(id,message='menu',kind='MESSAGE'){
 const value={metadata:{phone_number_id:phone}};
 if(kind==='MESSAGE')value.messages=[{id,from:'5215555550002',type:'text',text:{body:message}}];
 else value.statuses=[{id,status:'delivered',timestamp:'1800000000',recipient_id:'5215555550002'}];
 return Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{
  changes:[{field:'messages',value}]
 }]}));
}
function decision(tenant='tenant-r7'){
 return {allowed:true,actorId:'service-waba-123',actorType:'SERVICE',
  tenantId:tenant,audience:'Payment',permission:'payment.authorize',
  scopeType:'TENANT',scopeValue:null,scopeTenantId:tenant,
  decisionCode:'ALLOW',token:'delegated-token-fake-r7-0000000001'};
}
test('R7 Security Engine delegated intent matches exact service/authorize contract',()=>{
 assert.deepEqual(buildDelegationIntent({trustedTenantId:'tenant-r7'}),{
  targetTenantId:'tenant-r7',audience:'Payment',permission:'payment.authorize',
  scopeType:'TENANT',scopeValue:null,scopeTenantId:'tenant-r7',
  targetType:null,targetId:null
 });
 assert.throws(()=>buildDelegationIntent({trustedTenantId:'../../evil'}),/R7_TENANT_REQUIRED/);
});
test('R7 delegation disabled by default makes zero S2S requests',async()=>{
 let calls=0;
 const gate=createBusinessosDelegationGate({delegateTransport:async()=>{calls++;return {httpStatus:200,body:decision()};}});
 assert.deepEqual(await gate.delegate({trustedTenantId:'tenant-r7'}),{state:'DISABLED'});
 assert.equal(calls,0);
});
test('R7 Security Engine ALLOW must match tenant audience permission scope and actor exactly',async()=>{
 const good={httpStatus:200,body:decision()};
 const out=validateDelegationDecision(good,buildDelegationIntent({trustedTenantId:'tenant-r7'}));
 assert.equal(out.state,'DELEGATED_BOUNDED');
 assert.equal(out.principalId,'service-waba-123');
 assert.equal(out.delegatedBearer,good.body.token);
 for(const bad of [
  {...decision(),tenantId:'other-tenant'},
  {...decision(),audience:'Treasury'},
  {...decision(),permission:'payment.capture'},
  {...decision(),scopeType:'ORGANIZATION'},
  {...decision(),scopeValue:'org-other'},
  {...decision(),scopeTenantId:'other-tenant'},
  {...decision(),allowed:false},
  {...decision(),token:''},
  {...decision(),actorId:''}
 ]){
  assert.notEqual(validateDelegationDecision({httpStatus:200,body:bad},
   buildDelegationIntent({trustedTenantId:'tenant-r7'})).state,'DELEGATED_BOUNDED');
 }
});
test('R7 401 403 503 timeout and malformed PDP return safe no-effect outcomes',async()=>{
 const gate=createBusinessosDelegationGate({enabled:true,
  delegateTransport:async intent=>{
   assert.equal(intent.audience,'Payment');
   assert.equal(intent.permission,'payment.authorize');
   throw Error('SECRET_SERVICE_CREDENTIAL_MUST_NOT_LEAK');
  }});
 assert.deepEqual(await gate.delegate({trustedTenantId:'tenant-r7'}),
  {state:'UNAVAILABLE_NO_EFFECT'});
 for(const code of [401,403,503]){
  const result=validateDelegationDecision({httpStatus:code,body:{allowed:true}},
   buildDelegationIntent({trustedTenantId:'tenant-r7'}));
  assert.equal(result.state,code===503?'UNAVAILABLE_NO_EFFECT':'DENIED_NO_EFFECT');
 }
});
test('R7 invalid caller tenant fails before S2S, and valid intent sent once',async()=>{
 let calls=0;
 const gate=createBusinessosDelegationGate({enabled:true,delegateTransport:async intent=>{
  calls++;assert.equal(intent.scopeTenantId,'tenant-r7');
  return {httpStatus:200,body:decision()};
 }});
 assert.equal((await gate.delegate({trustedTenantId:''})).state,'INVALID_INTENT_NO_EFFECT');
 assert.equal(calls,0);
 assert.equal((await gate.delegate({trustedTenantId:'tenant-r7'})).state,'DELEGATED_BOUNDED');
 assert.equal(calls,1);
});
let pool,ingress,normalizer,router;
const {before,after}=require('node:test');
if(process.env.R4_POSTGRES_TEST_URL){
 before(async()=>{
  pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:16});
  await applyTestChannelMigrations(pool,
   ['waba-r4-channel.sql','waba-r5-channel.sql','waba-r6-channel.sql','waba-r7-channel.sql']);
  ingress=createPgSignedInbox({pool,appSecret:SECRET,encryptionKey:KEY});
  normalizer=createPgInboxNormalizer({pool,encryptionKey:KEY});
  router=createPgRoutingGate({pool,encryptionKey:KEY});
 });
 after(async()=>{if(pool)await pool.end();});
}
async function ready(id,cmd='menu',kind='MESSAGE'){
 const raw=event(id,cmd,kind),h=hash(raw);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:raw,signature:sign(raw)})).state,'STORED');
 assert.equal((await normalizer.processNext({envelopeDigest:h})).state,'NORMALIZED');
 return h;
}
async function routes(id){
 const r=await pool.query('SELECT route_code FROM waba_channel.routing_decisions WHERE message_id=$1',[id]);
 return r.rows.map(x=>x.route_code);
}
pgTest('R7 MENU stages one candidate, never invokes webhook or financial services',async()=>{
 const id='wamid.r7.menu.AAAA';
 await ready(id,'menu');
 assert.deepEqual(await router.stageNext({messageId:id}),
  {state:'STAGED_NO_EFFECT',routeCode:'MENU_CANDIDATE'});
 assert.equal((await router.stageNext({messageId:id})).state,'EMPTY');
 assert.deepEqual(await routes(id),['MENU_CANDIDATE']);
 assert.equal(router.isExternallyDispatching,false);
});
pgTest('R7 financial-looking command remains blocked awaiting Security Engine, not PAID',async()=>{
 for(const [suffix,cmd] of [['A','cobrar'],['B','pagar'],['C','tarjetas'],['D','nip']]){
  const id='wamid.r7.financial.'+suffix;
  await ready(id,cmd);
  assert.deepEqual(await router.stageNext({messageId:id}),
   {state:'STAGED_NO_EFFECT',routeCode:'AWAITING_SECURITY_ENGINE'});
  assert.deepEqual(await routes(id),['AWAITING_SECURITY_ENGINE']);
 }
 const r=await pool.query("SELECT count(*)::int AS n FROM waba_channel.routing_decisions WHERE route_code='AWAITING_SECURITY_ENGINE' AND message_id LIKE 'wamid.r7.financial.%'");
 assert.equal(r.rows[0].n,4);
});
pgTest('R7 unknown messages and Meta delivery statuses cannot trigger finance actions',async()=>{
 const a='wamid.r7.unknown.AAAA',b='wamid.r7.status.AAAA';
 await ready(a,'transferir 999999 MXN');
 await ready(b,'', 'STATUS_DELIVERED');
 assert.equal((await router.stageNext({messageId:a})).routeCode,'IGNORED_UNKNOWN');
 assert.equal((await router.stageNext({messageId:b})).routeCode,'IGNORED_STATUS');
});
pgTest('R7 ten workers stage one event only via row locks, safe after restart',async()=>{
 const id='wamid.r7.concurrent.AAAA';
 await ready(id,'menú');
 const outcomes=await Promise.all(Array.from({length:10},()=>
  createPgRoutingGate({pool,encryptionKey:KEY}).stageNext({messageId:id})));
 assert.equal(outcomes.filter(x=>x.state==='STAGED_NO_EFFECT').length,1);
 assert.equal(outcomes.filter(x=>x.state==='EMPTY'||x.state==='DUPLICATE_NO_EFFECT').length,9);
 assert.equal((await routes(id)).length,1);
 const other=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const recovered=createPgRoutingGate({pool:other,encryptionKey:KEY});
  assert.equal((await recovered.stageNext({messageId:id})).state,'EMPTY');
 }finally{await other.end();}
});
pgTest('R7 unnormalized or invalid signed ingress has no routing candidate',async()=>{
 const id='wamid.r7.unsigned.AAAA',raw=event(id);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:raw,signature:'sha256='+('0'.repeat(64))})).state,'UNVERIFIED');
 assert.equal((await router.stageNext({messageId:id})).state,'EMPTY');
 const id2='wamid.r7.notnorm.AAAA',raw2=event(id2);
 assert.equal((await ingress.persistSignedEnvelope({rawBody:raw2,signature:sign(raw2)})).state,'STORED');
 assert.equal((await router.stageNext({messageId:id2})).state,'EMPTY');
});
pgTest('R7 tampered encrypted envelope after normalization stages manual review, never action',async()=>{
 const id='wamid.r7.corrupt.AAAA',h=await ready(id,'menu');
 await pool.query('UPDATE waba_channel.signed_envelopes SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE envelope_digest=$1',[h]);
 assert.deepEqual(await router.stageNext({messageId:id}),
  {state:'STAGED_NO_EFFECT',routeCode:'REQUIRES_REVIEW'});
 assert.deepEqual(await routes(id),['REQUIRES_REVIEW']);
});
pgTest('R7 SQL failure rolls back routing decision and retry succeeds',async()=>{
 const id='wamid.r7.abort.AAAA';await ready(id,'menu');
 await pool.query("CREATE OR REPLACE FUNCTION waba_channel.r7_fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='wamid.r7.abort.AAAA' THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER r7_test_abort BEFORE INSERT ON waba_channel.routing_decisions FOR EACH ROW EXECUTE FUNCTION waba_channel.r7_fail_test()');
 try{
  assert.equal((await router.stageNext({messageId:id})).state,'RETRYABLE_NO_EFFECT');
  assert.deepEqual(await routes(id),[]);
 }finally{
  await pool.query('DROP TRIGGER r7_test_abort ON waba_channel.routing_decisions');
  await pool.query('DROP FUNCTION waba_channel.r7_fail_test()');
 }
 assert.equal((await router.stageNext({messageId:id})).routeCode,'MENU_CANDIDATE');
});
pgTest('R7 database unavailable and invalid selectors fail closed with no error disclosure',async()=>{
 assert.equal((await router.stageNext({messageId:'wrong'})).state,'INVALID');
 const disconnected=createPgRoutingGate({
  pool:{connect:async()=>{throw Error('PRIVATE_HOST_OR_PASSWORD');}},encryptionKey:KEY
 });
 assert.deepEqual(await disconnected.stageNext(),{state:'RETRYABLE_NO_EFFECT'});
});
pgTest('R7 persisted decisions have no plaintext message or bearer token columns',async()=>{
 const r=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='waba_channel' AND table_name='routing_decisions'");
 const names=r.rows.map(x=>x.column_name);
 assert.equal(names.includes('message_text'),false);
 assert.equal(names.includes('bearer'),false);
 assert.equal(names.includes('authorization_token'),false);
});
