'use strict';
// R9 Security Engine HTTPS is simulated in memory. No live PDP or credentials.
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {AUTHORIZE,canonicalEndpoint,createSecurityEngineS2SClient}=
 require('../src/businessosSecurityS2SClient');
const SERVICE_CREDENTIAL='offline-SERVICE-credential-only-test-123456';
const DELEGATED='delegated-Payment-token-offline-1234567890';
function decision(tenant='tenant-r9'){
 return {allowed:true,actorId:'waba-service-offline',actorType:'SERVICE',
  tenantId:tenant,audience:'Payment',permission:'payment.authorize',
  scopeType:'TENANT',scopeValue:null,scopeTenantId:tenant,
  decisionCode:'ALLOW',reasonCode:null,token:DELEGATED};
}
function mockHttps({status=200,response=decision(),raw=null,
 contentType='application/json',error=null,oversize=false}={}){
 const calls=[];
 function requestImpl(options,onResponse){
  const req=new EventEmitter();
  req.destroy=()=>{req.emit('error',Error('request destroyed offline'));};
  req.end=wire=>{
   const body=Buffer.from(wire);
   calls.push({options,body});
   queueMicrotask(()=>{
    if(error){req.emit(error,Error('SIMULATED_PDP_NETWORK_PRIVATE_PASSWORD'));return;}
    const res=new EventEmitter();
    res.statusCode=status;
    res.headers={'content-type':contentType};
    onResponse(res);
    const payload=oversize?'x'.repeat(40000):
     raw===null?JSON.stringify(response):raw;
    if(payload){
     if(payload.length>10){
      res.emit('data',Buffer.from(payload.slice(0,10)));
      res.emit('data',Buffer.from(payload.slice(10)));
     }else res.emit('data',Buffer.from(payload));
    }
    res.emit('end');
   });
  };
  return req;
 }
 return {requestImpl,calls};
}
function create(fake,{enabled=true,credentialProvider=async()=>SERVICE_CREDENTIAL,
 baseUrl='https://security-engine.internal',timeoutMs=4500}={}){
 return createSecurityEngineS2SClient({enabled,baseUrl,
  credentialProvider,requestImpl:fake.requestImpl,timeoutMs});
}
test('R9 HTTPS endpoint fixed and input URLs cannot move request or smuggle credentials',()=>{
 for(const baseUrl of [
  'http://security-engine.internal',
  'https://name:password@security-engine.internal',
  'https://security-engine.internal/internal/security/v1/service/authorize',
  'https://security-engine.internal/?url=https://evil.test',
  'https://security-engine.internal/#fragment',
  'file:///etc/passwd',
  'https://security-engine.internal\\@evil.invalid/'
 ]){
  assert.throws(()=>canonicalEndpoint(baseUrl),/R9_ENDPOINT_INVALID/);
 }
 const ep=canonicalEndpoint('https://security-engine.internal/');
 assert.equal(ep.path,'/internal/security/v1/service/authorize');
 assert.equal(ep.hostname,'security-engine.internal');
 assert.equal(AUTHORIZE,ep.path);
 assert.equal(Object.isFrozen(ep),true);
});
test('R9 opt-in disabled does not even read the ServiceCredential nor open HTTPS socket',async()=>{
 let credentialCalls=0;
 const fake=mockHttps();
 const client=create(fake,{enabled:false,credentialProvider:async()=>{
  credentialCalls++;throw Error('credential should not be touched');
 }});
 assert.deepEqual(await client.delegate({trustedTenantId:'tenant-r9'}),{state:'DISABLED'});
 assert.equal(fake.calls.length,0);assert.equal(credentialCalls,0);
 assert.equal(client.isFinancialDispatcher,false);
});
test('R9 trusted tenant input validation fails before credential lookup or network',async()=>{
 let called=0;
 const fake=mockHttps();
 const client=create(fake,{credentialProvider:async()=>{called++;return SERVICE_CREDENTIAL;}});
 assert.deepEqual(await client.delegate({trustedTenantId:'../../evil'}),
  {state:'INVALID_INTENT_NO_EFFECT'});
 assert.deepEqual(await client.delegate({trustedTenantId:''}),
  {state:'INVALID_INTENT_NO_EFFECT'});
 assert.equal(called,0);assert.equal(fake.calls.length,0);
});
test('R9 exact HTTPS POST wire fields and ALLOW decision bound to tenant and principal',async()=>{
 const fake=mockHttps();
 const client=create(fake);
 const result=await client.delegate({trustedTenantId:'tenant-r9'});
 assert.deepEqual(result,{state:'DELEGATED_BOUNDED',trustedTenantId:'tenant-r9',
  principalId:'waba-service-offline',delegatedBearer:DELEGATED});
 assert.equal(fake.calls.length,1);
 const call=fake.calls[0];
 const options=call.options;
 assert.equal(options.protocol,'https:');
 assert.equal(options.method,'POST');
 assert.equal(options.hostname,'security-engine.internal');
 assert.equal(options.servername,'security-engine.internal');
 assert.equal(options.path,AUTHORIZE);
 assert.equal(options.rejectUnauthorized,true);
 assert.equal(options.headers.Authorization,'Bearer '+SERVICE_CREDENTIAL);
 assert.equal(options.headers.Accept,'application/json');
 assert.equal(options.headers['Cache-Control'],'no-store');
 assert.equal(options['maxRedirects'],0);
 assert.equal(options.timeout,4500);
 assert.deepEqual(JSON.parse(call.body.toString('utf8')),{
  targetTenantId:'tenant-r9',audience:'Payment',
  permission:'payment.authorize',scopeType:'TENANT',
  scopeValue:null,scopeTenantId:'tenant-r9',targetType:null,targetId:null
 });
 assert.ok(!call.body.includes(Buffer.from(SERVICE_CREDENTIAL)));
 assert.ok(!call.body.includes(Buffer.from(DELEGATED)));
 assert.equal(options.path.includes(SERVICE_CREDENTIAL),false);
});
test('R9 long opaque ServiceCredential allowed only in header and never in delegated result',async()=>{
 const secret='eyJhbGciOiJSUzI1NiJ9.'+'a'.repeat(320)+'.'+'b'.repeat(320);
 const fake=mockHttps();
 const client=create(fake,{credentialProvider:async()=>secret});
 const result=await client.delegate({trustedTenantId:'tenant-r9'});
 assert.equal(result.state,'DELEGATED_BOUNDED');
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(fake.calls[0].options.headers.Authorization,'Bearer '+secret);
 assert.ok(!fake.calls[0].body.toString('utf8').includes(secret));
});
test('R9 missing/invalid ServiceCredential prevents network request fail closed',async()=>{
 for(const secret of ['',null,'bearer contains spaces','short','\nINJECTED','Bearer token']){
  const fake=mockHttps();
  const client=create(fake,{credentialProvider:async()=>secret});
  const result=await client.delegate({trustedTenantId:'tenant-r9'});
  assert.equal(result.state,'UNAVAILABLE_NO_EFFECT');
  assert.equal(fake.calls.length,0);
 }
});
test('R9 service credential provider failure never discloses exception or opens network',async()=>{
 const fake=mockHttps();
 const client=create(fake,{credentialProvider:async()=>{
  throw Error('PRIVATE_SECURITY_ENGINE_CREDENTIAL_DO_NOT_ECHO');
 }});
 const r=await client.delegate({trustedTenantId:'tenant-r9'});
 assert.deepEqual(r,{state:'UNAVAILABLE_NO_EFFECT'});
 assert.ok(!JSON.stringify(r).includes('PRIVATE_SECURITY_ENGINE'));
 assert.equal(fake.calls.length,0);
});
test('R9 401 and 403 fail with DENIED; 503, 429, 307 fail unavailable, no redirects',async()=>{
 for(const [status,state] of [
  [401,'DENIED_NO_EFFECT'],[403,'DENIED_NO_EFFECT'],
  [503,'UNAVAILABLE_NO_EFFECT'],[429,'UNAVAILABLE_NO_EFFECT'],
  [307,'UNAVAILABLE_NO_EFFECT']
 ]){
  const fake=mockHttps({status,response:{allowed:true,token:'ATTACKER'}});
  const client=create(fake);
  assert.equal((await client.delegate({trustedTenantId:'tenant-r9'})).state,state);
  assert.equal(fake.calls.length,1);
 }
});
test('R9 tenant, permission, audience, actor and token mismatch fail closed',async()=>{
 const cases=[
  {...decision(),tenantId:'tenant-other'},
  {...decision(),scopeTenantId:'tenant-other'},
  {...decision(),audience:'Stay'},
  {...decision(),permission:'payment.capture'},
  {...decision(),scopeType:'RESOURCE'},
  {...decision(),scopeValue:'other'},
  {...decision(),actorId:''},
  {...decision(),actorType:''},
  {...decision(),token:''},
  {...decision(),allowed:false}
 ];
 for(const bad of cases){
  const fake=mockHttps({response:bad});
  const out=await create(fake).delegate({trustedTenantId:'tenant-r9'});
  assert.notEqual(out.state,'DELEGATED_BOUNDED');
  assert.equal(fake.calls.length,1);
 }
});
test('R9 malformed JSON, HTML, empty body, array and oversized response never grant authority',async()=>{
 for(const f of [
  {raw:'{'},
  {raw:''},
  {raw:'[]'},
  {contentType:'text/html'},
  {oversize:true}
 ]){
  const fake=mockHttps(f);
  const out=await create(fake).delegate({trustedTenantId:'tenant-r9'});
  assert.deepEqual(out,{state:'UNAVAILABLE_NO_EFFECT'});
  assert.equal(fake.calls.length,1);
 }
});
test('R9 connection reset, abort, timeout, socket failure are bounded, no second POST',async()=>{
 for(const err of ['error','timeout']){
  const fake=mockHttps({error:err});
  const out=await create(fake).delegate({trustedTenantId:'tenant-r9'});
  assert.deepEqual(out,{state:'UNAVAILABLE_NO_EFFECT'});
  assert.equal(fake.calls.length,1);
 }
});
test('R9 invalid timeout and credential resolver contract reject configuration',()=>{
 for(const timeoutMs of [0,-1,50,40000,1.5]){
  const fake=mockHttps();
  assert.throws(()=>create(fake,{timeoutMs}),/R9_CONFIG_INVALID/);
 }
 assert.throws(()=>createSecurityEngineS2SClient({
  enabled:true,baseUrl:'https://security-engine.internal',
  credentialProvider:'not a function',requestImpl:()=>{}
 }),/R9_CONFIG_INVALID/);
});
