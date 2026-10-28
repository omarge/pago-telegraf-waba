'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {api}=require('../src/waba');
function mock(status,payload){
 return (opts,onResponse)=>{
  assert.equal(opts.hostname,'graph.facebook.com');
  const req=new EventEmitter();
  req.write=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const res=new EventEmitter();
   res.statusCode=status;
   onResponse(res);
   res.emit('data',typeof payload==='string'?payload:JSON.stringify(payload));
   res.emit('end');
  });
  req.destroy=()=>{};
  return req;
 };
}
const logger={log(){},error(){}};
test('Meta HTTP 401 OAuth 190 is a rejected outbound WhatsApp operation',async()=>{
 await assert.rejects(
  api('POST','123/messages',{to:'5215555550001'},{
   request:mock(401,{error:{code:190,type:'OAuthException',message:'Authentication Error'}}),logger
  }),
  /Meta WhatsApp API HTTP 401 code=190/
 );
});
test('Meta 2xx Graph API error must fail closed',async()=>{
 await assert.rejects(
  api('POST','123/messages',{to:'5215555550001'},{
   request:mock(200,{error:{code:190,type:'OAuthException'}}),logger
  }),
  /HTTP 200 code=190/
 );
});
test('Meta malformed/missing message acceptance does not report success',async()=>{
 await assert.rejects(
  api('POST','123/messages',{}, {request:mock(200,'not-json'),logger}),
  /malformed response/
 );
 await assert.rejects(
  api('POST','123/messages',{}, {request:mock(200,{foo:'bar'}),logger}),
  /did not confirm message acceptance/
 );
});
test('Meta accepted outbound message preserves result without secret-bearing logs',async()=>{
 const accepted={messaging_product:'whatsapp',messages:[{id:'wamid.mock123'}]};
 assert.deepEqual(await api('POST','123/messages',{to:'5215555550001'},{
  request:mock(200,accepted),logger
 }),accepted);
});
