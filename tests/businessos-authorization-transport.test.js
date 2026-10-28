'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createBusinessosHttpsTransport}=require('../src/businessosAuthorizationTransport');
const payload={tenantId:'tenant-r1-test',paymentIntentId:'waba-int-test',
 paymentAttemptId:'waba-att-test',amount:'10.00',currency:'MXN',
 idempotencyKey:'waba-idem-123'};
const token='delegated-offline-only-test-token-123456789';
function fakeRequest({httpStatus=200,body={status:'AUTHORIZED'},failure=null,
 isChunked=false}={}){
 const calls=[];
 const requestImpl=(opts,onResponse)=>{
  calls.push(opts);
  const req=new EventEmitter();
  req.destroy=()=>{req.emit('error',Error('closed'));};
  req.end=(wire)=>{
   calls.push(JSON.parse(wire.toString('utf8')));
   queueMicrotask(()=>{
    if(failure){req.emit(failure,Error('simulated-network-error'));return;}
    const res=new EventEmitter();
    res.statusCode=httpStatus;
    onResponse(res);
    const data=typeof body==='string'?body:JSON.stringify(body);
    if(isChunked){
     for(const piece of [data.slice(0,5),data.slice(5)])res.emit('data',Buffer.from(piece));
    }else res.emit('data',Buffer.from(data));
    res.emit('end');
   });
  };
  return req;
 };
 return {requestImpl,calls};
}
test('BusinessOS R1 HTTPS transport only accepts operator-defined secure base URL',()=>{
 for(const baseUrl of ['http://businessos.internal','https://usr:pw@example.com',
  'https://service.local/relative','https://service.local/?x=1',
  'file:///etc/passwd','https://service.local/#fragment']){
  assert.throws(()=>createBusinessosHttpsTransport({baseUrl}),/BUSINESSOS_ENDPOINT_INVALID/);
 }
 assert.equal(typeof createBusinessosHttpsTransport({baseUrl:'https://businessos.internal'}),'function');
});
test('BusinessOS R1 POST matches Payment Engine exact path, bearer is header not JSON body',async()=>{
 const fake=fakeRequest();
 const transport=createBusinessosHttpsTransport({
  baseUrl:'https://businessos.internal',requestImpl:fake.requestImpl
 });
 const result=await transport({method:'POST',path:'/internal/v1/payment-authorizations',
  body:payload,delegatedBearer:token});
 assert.equal(result.httpStatus,200);
 assert.equal(result.body.status,'AUTHORIZED');
 const opts=fake.calls[0];
 assert.equal(opts.protocol,'https:');
 assert.equal(opts.hostname,'businessos.internal');
 assert.equal(opts.path,'/internal/v1/payment-authorizations');
 assert.equal(opts.method,'POST');
 assert.equal(opts.headers.Authorization,'Bearer '+token);
 assert.equal(opts.maxRedirects,0);
 assert.equal(fake.calls[1].amount,'10.00');
 assert.ok(!JSON.stringify(fake.calls[1]).includes(token));
});
test('BusinessOS R1 HTTP transport prohibits caller-selected destinations, methods and missing bearer',async()=>{
 let called=0;
 const transport=createBusinessosHttpsTransport({
  baseUrl:'https://businessos.internal',
  requestImpl:()=>{called++;throw Error('should not be invoked');}
 });
 for(const args of [
  {method:'GET',path:'/internal/v1/payment-authorizations',body:payload,delegatedBearer:token},
  {method:'POST',path:'/admin',body:payload,delegatedBearer:token},
  {method:'POST',path:'/internal/v1/payment-authorizations',body:payload,delegatedBearer:''}
 ]){
  await assert.rejects(transport(args),/BUSINESSOS_TRANSPORT_INPUT_INVALID/);
 }
 assert.equal(called,0);
});
test('BusinessOS R1 malformed/truncated 200 and network reset fail closed (no response exposed)',async()=>{
 for(const setting of [{body:'not-json'}, {failure:'error'}]){
  const fake=fakeRequest(setting);
  const transport=createBusinessosHttpsTransport({
   baseUrl:'https://businessos.internal',requestImpl:fake.requestImpl});
  await assert.rejects(transport({method:'POST',path:'/internal/v1/payment-authorizations',
   body:payload,delegatedBearer:token}),/BUSINESSOS_REQUEST_INDETERMINATE/);
  assert.equal(fake.calls.filter(x=>x?.method==='POST').length,1);
 }
});
test('BusinessOS R1 body over 16kb fails before any HTTP request',async()=>{
 let called=0;
 const transport=createBusinessosHttpsTransport({baseUrl:'https://businessos.internal',
  requestImpl:()=>{called++;throw Error('request sent');}});
 await assert.rejects(transport({method:'POST',path:'/internal/v1/payment-authorizations',
  body:{payload:'x'.repeat(20000)},delegatedBearer:token}),/BUSINESSOS_PAYLOAD_TOO_LARGE/);
 assert.equal(called,0);
});
test('BusinessOS R1 transport parses chunked JSON once, does not auto retry',async()=>{
 const fake=fakeRequest({isChunked:true,httpStatus:200,body:{status:'UNKNOWN'}});
 const send=createBusinessosHttpsTransport({baseUrl:'https://businessos.internal',
  requestImpl:fake.requestImpl});
 const result=await send({method:'POST',path:'/internal/v1/payment-authorizations',
  body:payload,delegatedBearer:token});
 assert.equal(result.body.status,'UNKNOWN');
 assert.equal(fake.calls.filter(x=>x?.method==='POST').length,1);
});
