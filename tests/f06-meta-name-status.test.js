'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {readMetaNameStatus,classify,run}=require('../scripts/f06-meta-name-status');
const token='EAA_test_token_no_secret_123456789';
const phoneId='1478834131971433';
function mock({status=200,body={name_status:'PENDING_REVIEW'}}={}){
 const requests=[];
 const transport={request(opts,cb){
  requests.push(opts);
  const req=new EventEmitter();
  req.end=()=>queueMicrotask(()=>{
   const res=new EventEmitter();
   res.statusCode=status;
   cb(res);
   res.emit('data',JSON.stringify(body));
   res.emit('end');
  });
  req.destroy=()=>{};
  return req;
 }};
 return {transport,requests};
}
test('F06 Meta diagnostic does exactly one GET on phone number name_status without sending message',async()=>{
 const f=mock();
 assert.equal(await readMetaNameStatus({token,phoneId,transport:f.transport}),'PENDING_REVIEW');
 assert.equal(f.requests.length,1);
 assert.equal(f.requests[0].method,'GET');
 assert.equal(f.requests[0].path,'/v26.0/'+phoneId+'?fields=name_status');
 assert.equal(f.requests[0].hostname,'graph.facebook.com');
 assert.ok(f.requests[0].headers.Authorization.startsWith('Bearer '));
 assert.ok(!f.requests[0].path.includes('messages'));
});
test('F06 Meta statuses distinguish name readiness from actual delivery',()=>{
 assert.equal(classify('APPROVED'),'NAME_READY_DELIVERY_UNVERIFIED');
 assert.equal(classify('AVAILABLE_WITHOUT_REVIEW'),'NAME_READY_DELIVERY_UNVERIFIED');
 assert.equal(classify('PENDING_REVIEW'),'BLOCKED_PENDING_NAME_REVIEW');
 assert.equal(classify('DECLINED'),'BLOCKED_NAME_DECLINED');
 assert.equal(classify('EXPIRED'),'BLOCKED_NAME_UNAVAILABLE');
});
test('F06 131037 context: pending name is blocked, no promises of delivery',async()=>{
 const f=mock(),lines=[];
 const r=await run({env:{WABA_TOKEN:token,WABA_PHONE_ID:phoneId},
  transport:f.transport,log:{log:line=>lines.push(line)}});
 assert.equal(r.gate,'BLOCKED_PENDING_NAME_REVIEW');
 assert.ok(lines.includes('F06_META_DELIVERY=NOT_CERTIFIED'));
 assert.ok(lines.includes('F06_META_MESSAGES_SENT=0'));
 assert.ok(lines.includes('F06_OPENPAY_CHARGES=0'));
 assert.ok(!lines.join('\n').includes(token));
 assert.ok(!lines.join('\n').includes(phoneId));
});
test('F06 unsupported beta name_status fails closed without revealing response',async()=>{
 const f=mock({status:400,body:{error:{message:'SECRET_TOKEN',code:100}}});
 await assert.rejects(readMetaNameStatus({token,phoneId,transport:f.transport}),e=>{
  assert.equal(e.message,'F06_META_GET_UNAVAILABLE');return true;
 });
});
test('F06 missing name_status or malformed metadata cannot declare ready',async()=>{
 for(const body of [{id:phoneId},{name_status:'SOMETHING_ELSE'},null]){
  const f=mock({body});
  await assert.rejects(readMetaNameStatus({token,phoneId,transport:f.transport}),
   /F06_META_NAME_STATUS_UNAVAILABLE/);
 }
});
test('F06 missing token or phone ID does not issue network request',async()=>{
 const f=mock();
 await assert.rejects(readMetaNameStatus({token:'',phoneId,transport:f.transport}),/F06_META_CONFIG_MISSING/);
 assert.equal(f.requests.length,0);
});
