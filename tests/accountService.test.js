'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const express=require('express');
const {createAccountService,SESSION_MS,LINK_MS}=require('../src/accountService');
const {createAccountRouter}=require('../src/accountRoutes');
const {createWebhook}=require('../src/webhook');

test('register, independent login, session expiration and logout',()=>{
 let time=1000;
 const service=createAccountService({filePath:null,now:()=>time});
 assert.throws(()=>service.register('a@example.com','short'),/contraseña/);
 const a=service.register('a@example.com','correct-password-111');
 const b=service.register('b@example.com','correct-password-222');
 assert.notEqual(a.token,b.token);
 assert.equal(service.getSession(a.token).email,'a@example.com');
 assert.equal(service.getSession(b.token).whatsappLinked,false);
 assert.equal(service.login('a@example.com','incorrect-password'),null);
 assert.ok(service.login('a@example.com','correct-password-111'));
 assert.equal(service.validCsrf(a.token,b.csrf),false);
 assert.equal(service.validCsrf(a.token,a.csrf),true);
 service.logout(a.token);
 assert.equal(service.getSession(a.token),null);
 time+=SESSION_MS+1;
 assert.equal(service.getSession(b.token),null);
});
test('linking requires web-issued code plus originating WhatsApp, no cross-account takeover',()=>{
 let time=10000;
 const service=createAccountService({filePath:null,now:()=>time});
 const a=service.register('a@example.com','correct-password-111');
 const b=service.register('b@example.com','correct-password-222');
 assert.equal(service.beginLink('invalid',a.csrf),null);
 assert.equal(service.beginLink(a.token,b.csrf),null);
 const challenge=service.beginLink(a.token,a.csrf);
 assert.match(challenge.code,/^[0-9A-F]{16}$/);
 assert.equal(service.bindFromWhatsApp('5215500000000','FFFFFFFFFFFFFFFF'),false);
 assert.equal(service.bindFromWhatsApp('5215500000000',challenge.code),true);
 assert.equal(service.bindFromWhatsApp('5215500000000',challenge.code),false);
 assert.equal(service.getSession(a.token).whatsappLinked,true);
 assert.equal(service.getSession(b.token).whatsappLinked,false);
 const other=service.beginLink(b.token,b.csrf);
 assert.equal(service.bindFromWhatsApp('5215500000000',other.code),false);
 assert.equal(service.bindFromWhatsApp('5215500000001',other.code),false);
 const c=service.register('c@example.com','correct-password-333');
 const expires=service.beginLink(c.token,c.csrf);
 time+=LINK_MS+1;
 assert.equal(service.bindFromWhatsApp('5215500000002',expires.code),false);
});
test('persisted account survives restart, but no credentials/session/code plaintext',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waba-f02-'));
 const file=path.join(dir,'accounts.json');
 try{
  const service=createAccountService({filePath:file});
  const a=service.register('test@example.com','private-password-123');
  const code=service.beginLink(a.token,a.csrf);
  assert.equal(service.bindFromWhatsApp('5215500000000',code.code),true);
  const json=fs.readFileSync(file,'utf8');
  assert.doesNotMatch(json,/private-password-123/);
  assert.equal(json.includes(a.token),false);
  assert.equal(json.includes(code.code),false);
  const restored=createAccountService({filePath:file});
  assert.equal(restored.getSession(a.token),null);
  assert.ok(restored.getLinkedAccount('5215500000000'));
  assert.ok(restored.login('test@example.com','private-password-123'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('WhatsApp vincular never logs code or creates payment',async()=>{
 const service=createAccountService({filePath:null});
 const a=service.register('web@example.com','a-very-long-password-001');
 const code=service.beginLink(a.token,a.csrf).code;
 const outgoing=[],logs=[];
 const api=createWebhook({
  accounts:service,
  store:{conv:new Map(),createInvite(){throw Error('unexpected payment');}},
  messenger:{async sendMessage(_to,msg){outgoing.push(msg);return {messages:[{id:'fake'}]};}},
  log:{log(...args){logs.push(args.join(' '));},error(...args){logs.push(args.join(' '));}}
 });
 await api.handleWebhook({entry:[{changes:[{value:{messages:[{
  from:'5215500000000',type:'text',text:{body:'vincular '+code}
 }]}}]}]});
 assert.equal(outgoing.length,1);
 assert.match(outgoing[0],/vinculado/);
 assert.equal(logs.join(' ').includes(code),false);
 assert.equal(service.getSession(a.token).whatsappLinked,true);
});
test('HTTP microapps require login; session, CSRF, logout, bind flow work',async()=>{
 const service=createAccountService({filePath:null});
 const app=express();
 app.use('/pay/app',createAccountRouter({service}));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const request=(url,opts={})=>fetch(base+url,{redirect:'manual',...opts});
  let r=await request('/pay/app/cards');
  assert.equal(r.status,303);
  assert.equal(r.headers.get('location'),'/pay/app/login');
  r=await request('/pay/app/api/session');
  assert.equal(r.status,303);
  const body=new URLSearchParams({email:'web@example.com',password:'example-password-long-123'});
  r=await request('/pay/app/register',{method:'POST',body});
  assert.equal(r.status,303);
  const setCookie=r.headers.get('set-cookie');
  assert.match(setCookie,/HttpOnly/i);
  assert.match(setCookie,/Secure/i);
  const cookie=setCookie.split(';')[0];
  r=await request('/pay/app/api/session',{headers:{cookie}});
  assert.equal(r.status,200);
  assert.equal((await r.json()).whatsappLinked,false);
  r=await request('/pay/app/cards',{headers:{cookie}});
  assert.equal(r.status,200);
  assert.match(await r.text(),/Módulo en preparación/);
  const session=service.getSession(cookie.split('=')[1]);
  r=await request('/pay/app/bind',{method:'POST',headers:{cookie},
   body:new URLSearchParams({_csrf:'invalid'})});
  assert.equal(r.status,403);
  r=await request('/pay/app/bind',{method:'POST',headers:{cookie},
   body:new URLSearchParams({_csrf:session.csrf})});
  assert.equal(r.status,200);
  assert.match(await r.text(),/vincular [0-9A-F]{16}/);
  r=await request('/pay/app/logout',{method:'POST',headers:{cookie},
   body:new URLSearchParams({_csrf:session.csrf})});
  assert.equal(r.status,303);
  r=await request('/pay/app/cards',{headers:{cookie}});
  assert.equal(r.status,303);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
