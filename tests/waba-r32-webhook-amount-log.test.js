'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createWebhook}=require('../src/webhook');
function fixture(){
 const sent=[],logged=[],conv=new Map();let created=0;
 const messenger={sendMessage:async(to,msg)=>{sent.push({to,msg});return {ok:true};},sendList:async()=>({ok:true})};
 const store={conv,createInvite:()=>{created++;return 'private-invite-bearer-token';}};
 const log={log:(...x)=>logged.push(x.map(String).join(' ')),error:()=>{}};
 const w=createWebhook({messenger,store,log,baseUrl:'https://example.invalid'});
 const send=async text=>w.handleMessage({from:'521555000001',type:'text',text:{body:text}});
 return {sent,logged,conv,send,get created(){return created;}};
}
test('R32-A invalid amount inputs cannot mint an invitation',async()=>{
 for(const value of ['1000abc','1.5','-1','0','1e3',' 12 34','9007199254740992']){
  const f=fixture();await f.send('cobrar');await f.send(value);
  assert.equal(f.created,0,value);
  assert.match(f.sent.at(-1).msg,/Monto inválido/);
 }
});
test('R32-A valid cent amount creates exactly one invitation',async()=>{
 const f=fixture();await f.send('cobrar');await f.send('1000');
 assert.equal(f.created,1);
 assert.match(f.sent.at(-1).msg,/private-invite-bearer-token/);
});
test('R32-B invitation URL never enters application log',async()=>{
 const f=fixture();await f.send('cobrar');await f.send('1000');
 const logs=f.logged.join(' ');
 assert.doesNotMatch(logs,/private-invite-bearer-token|example\\.invalid\\/pay\\/request/);
 assert.match(logs,/payment request link created/);
});
