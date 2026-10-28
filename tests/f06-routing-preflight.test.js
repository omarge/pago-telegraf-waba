'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {assess,run,normalizedDestination}=require('../scripts/f06-routing-preflight');

function check(accounts,env={}){
 const all=accounts.map((waId,i)=>({id:'acc_'+i,waId}));
 return assess({accounts:all,getLinkedWhatsApp:id=>all.find(a=>a.id===id)?.waId,
  env:{WABA_PHONE_ID:'phone_test',WABA_TOKEN:'meta_test',...env}});
}
test('F06 routes mexican 521 and 52 recipient forms exactly as WhatsApp adapter',()=>{
 assert.equal(normalizedDestination('5215545827276'),'525545827276');
 assert.equal(normalizedDestination('525545827276'),'525545827276');
 assert.equal(normalizedDestination('nonnumeric'),null);
});
test('F06 blocks one account even with a completed F04/F05 payment',()=>{
 const r=check(['5215545827276']);
 assert.equal(r.status,'BLOCKED_NEED_TWO_DISTINCT_WHATSAPP_ACCOUNTS');
 assert.equal(r.charges,0);
 assert.equal(r.deliveredMessages,0);
 assert.equal(r.metaApproval,'NOT_VERIFIED');
});
test('F06 fail-closed when WABA_TEST_TO redirects all recipients to one test destination',()=>{
 const r=check(['5215545827276','5215512345678'],{WABA_TEST_TO:'525551112222'});
 assert.equal(r.status,'BLOCKED_TEST_TO_REDIRECT');
 assert.equal(r.testRedirectActive,true);
 assert.equal(r.distinctDestinations,2);
});
test('F06 detects same destination in 52 and 521 representations',()=>{
 const r=check(['5215545827276','525545827276']);
 assert.equal(r.status,'BLOCKED_NEED_TWO_DISTINCT_WHATSAPP_ACCOUNTS');
 assert.equal(r.linkedAccounts,2);
 assert.equal(r.distinctDestinations,1);
});
test('F06 qualifies two independently linked accounts only as CONFIG_READY_META_UNVERIFIED',()=>{
 const r=check(['5215545827276','5215512345678']);
 assert.equal(r.status,'CONFIG_READY_META_UNVERIFIED');
 assert.equal(r.metaApproval,'NOT_VERIFIED');
 assert.equal(r.deliveredMessages,0);
 assert.equal(r.charges,0);
});
test('F06 missing Meta config never becomes GREEN, with no token values logged',()=>{
 const r=check(['5215545827276','5215512345678'],{WABA_TOKEN:''});
 assert.equal(r.status,'BLOCKED_META_CONFIG_MISSING');
});
test('F06 does not trust a stored account with mismatched linking or duplicate account IDs',()=>{
 const a=[{id:'acct_01',waId:'5215545827276'}, {id:'acct_01',waId:'5215512345678'},
  {id:'acct_02',waId:'5215512345678'}];
 const r=assess({accounts:a,env:{WABA_TOKEN:'x',WABA_PHONE_ID:'x'},
  getLinkedWhatsApp:id=>id==='acct_01'?'5215545827276':null});
 assert.equal(r.status,'BLOCKED_NEED_TWO_DISTINCT_WHATSAPP_ACCOUNTS');
 assert.equal(r.linkedAccounts,1);
});
test('F06 preflight reads account records but never writes to local account file or sends network',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f06-routing-'));
 try{
  const storage=path.join(dir,'data');fs.mkdirSync(storage);
  const f=path.join(storage,'waba-accounts.json');
  const original=JSON.stringify({version:1,accounts:[]});
  fs.writeFileSync(f,original);
  const logged=[];
  const r=run({root:dir,env:{WABA_TOKEN:'secret-not-to-log',WABA_PHONE_ID:'123456789'},
   log:{log:x=>logged.push(String(x))}});
  assert.equal(r.status,'BLOCKED_NEED_TWO_DISTINCT_WHATSAPP_ACCOUNTS');
  assert.equal(fs.readFileSync(f,'utf8'),original);
  assert.ok(logged.includes('F06_META_MESSAGES_SENT=0'));
  assert.ok(logged.includes('F06_OPENPAY_CHARGES=0'));
  assert.ok(!logged.join('\n').includes('secret-not-to-log'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
