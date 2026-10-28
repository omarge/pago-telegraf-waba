'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const express=require('express');
const {createAccountService}=require('../src/accountService');
const {createStatementJournal}=require('../src/statementJournal');
const {createAccountRouter}=require('../src/accountRoutes');
const {createVault}=require('../src/cardVault');
const {createSavedCardFlow}=require('../src/savedCardFlow');
const FIRST='KPR-'+'A'.repeat(32);
const SECOND='KPR-'+'B'.repeat(32);

function accountsWithLinkedUsers(filePath=null){
 const accounts=createAccountService({filePath});
 const payer=accounts.register('payer@example.com','payer-secret-1234567');
 const receiver=accounts.register('receiver@example.com','receiver-secret-123456');
 const stranger=accounts.register('stranger@example.com','stranger-secret-123456');
 for(const [session,wa] of [[payer,'5215555550001'],[receiver,'5215555550002']]){
  const code=accounts.beginLink(session.token,session.csrf).code;
  assert.equal(accounts.bindFromWhatsApp(wa,code),true);
 }
 return {accounts,payer,receiver,stranger,
  payerId:accounts.getSession(payer.token).accountId,
  receiverId:accounts.getSession(receiver.token).accountId,
  strangerId:accounts.getSession(stranger.token).accountId};
}
test('only verified receipts appear for payer and linked collector, never unrelated users',()=>{
 const {accounts,payerId,receiverId,strangerId}=accountsWithLinkedUsers();
 const journal=createStatementJournal({filePath:null,now:()=>1761600000000});
 const completed={requestId:FIRST,chargeId:'charge12345678',
  amountCents:1000,payerAccountId:payerId,requesterWaId:'5215555550002'};
 const receipt=journal.recordCompleted(completed);
 assert.equal(receipt.status,'completed');
 assert.equal(journal.listForAccount(payerId,accounts)[0].direction,'PAGO');
 assert.equal(journal.listForAccount(receiverId,accounts)[0].direction,'COBRO');
 assert.equal(journal.listForAccount(strangerId,accounts).length,0);
 assert.equal(journal.receiptForAccount(strangerId,FIRST,accounts),null);
 assert.equal(journal.recordCompleted(completed).chargeId,receipt.chargeId);
 assert.equal(journal.listForAccount(payerId,accounts).length,1);
 assert.throws(()=>journal.recordCompleted({...completed,requestId:SECOND}),/conflict/);
});
test('completed statements persist across restart; preferences remain per account',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waba-f05-'));
 try{
  const accountFile=path.join(dir,'accounts.json'),journalFile=path.join(dir,'journal.json');
  const f=accountsWithLinkedUsers(accountFile);
  const journal=createStatementJournal({filePath:journalFile});
  journal.recordCompleted({requestId:FIRST,chargeId:'charge12345678',amountCents:1000,
   payerAccountId:f.payerId,requesterWaId:'5215555550002'});
  assert.deepEqual(f.accounts.setPreferences(f.payerId,{
   alias:'Prueba WABA',whatsappReceipts:false
  }),{alias:'Prueba WABA',whatsappReceipts:false});
  assert.equal(f.accounts.getPreferences(f.receiverId).whatsappReceipts,true);
  assert.throws(()=>f.accounts.setPreferences(f.payerId,{
   alias:'x',whatsappReceipts:'false'
  }),/WhatsApp/);
  const restoredAccounts=createAccountService({filePath:accountFile});
  const restoredJournal=createStatementJournal({filePath:journalFile});
  assert.equal(restoredAccounts.getPreferences(f.payerId).alias,'Prueba WABA');
  assert.equal(restoredAccounts.getPreferences(f.payerId).whatsappReceipts,false);
  assert.equal(restoredJournal.listForAccount(f.receiverId,restoredAccounts).length,1);
  assert.equal(restoredJournal.listForAccount(f.strangerId,restoredAccounts).length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('authenticated pages and receipt access are account-scoped; settings require CSRF',async()=>{
 const f=accountsWithLinkedUsers();
 const journal=createStatementJournal({filePath:null});
 journal.recordCompleted({requestId:FIRST,chargeId:'charge12345678',amountCents:1000,
  payerAccountId:f.payerId,requesterWaId:'5215555550002'});
 const vault=createVault({filePath:null});
 const app=express();
 app.use('/pay/app',createAccountRouter({
  service:f.accounts,journal,vault,requestStore:{getRequest:()=>null}
 }));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const url='http://127.0.0.1:'+server.address().port;
  const call=(endpoint,options={})=>fetch(url+endpoint,{redirect:'manual',...options});
  const p={cookie:'kashbit_web_session='+f.payer.token};
  const r={cookie:'kashbit_web_session='+f.receiver.token};
  const stranger={cookie:'kashbit_web_session='+f.stranger.token};
  let response=await call('/pay/app/statement');
  assert.equal(response.status,303);
  response=await call('/pay/app/statement',{headers:p});
  assert.equal(response.status,200);
  assert.match(await response.text(),/\$10\.00 MXN/);
  response=await call('/pay/app/receipts',{headers:r});
  assert.equal(response.status,200);
  assert.match(await response.text(),/Cobro/);
  response=await call('/pay/app/api/statement',{headers:stranger});
  assert.deepEqual((await response.json()).movements,[]);
  response=await call('/pay/app/receipt/'+FIRST,{headers:stranger});
  assert.equal(response.status,404);
  response=await call('/pay/app/receipt/'+FIRST,{headers:p});
  assert.equal(response.status,200);
  assert.match(await response.text(),/charge12345678/);
  response=await call('/pay/app/settings',{headers:p});
  assert.equal(response.status,200);
  assert.match(await response.text(),/Guardar configuración/);
  response=await call('/pay/app/settings',{
   method:'POST',headers:p,body:new URLSearchParams({_csrf:'wrong',alias:'Mi cuenta'})
  });
  assert.equal(response.status,403);
  response=await call('/pay/app/settings',{
   method:'POST',headers:p,
   body:new URLSearchParams({_csrf:f.payer.csrf,alias:'Mi cuenta',whatsappReceipts:'yes'})
  });
  assert.equal(response.status,303);
  assert.equal(f.accounts.getPreferences(f.payerId).alias,'Mi cuenta');
  response=await call('/pay/app/settings',{
   method:'POST',headers:p,body:new URLSearchParams({_csrf:f.payer.csrf,alias:'Sin avisos'})
  });
  assert.equal(response.status,303);
  assert.equal(f.accounts.getPreferences(f.payerId).whatsappReceipts,false);
  assert.equal(f.accounts.getPreferences(f.receiverId).whatsappReceipts,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('F04 confirmed Sandbox flow writes statement and obeys payer notification preference',async()=>{
 const f=accountsWithLinkedUsers();
 const calls=[],notifications=[],journal=createStatementJournal({filePath:null});
 const provider={
  merchantId:'merchant1234',publicKey:'pk_mock',
  async getCard(customer,id){
   calls.push('getCard');
   return {id,customer_id:customer,card_number:'4242',brand:'visa',allows_charges:true};
  },
  async createCustomer(){return {id:'customer12345'};},
  async addCard(){return {id:'card12345678'};},
  async chargeSavedCard(){
   calls.push('charge');
   return {id:'charge12345678'};
  },
  async getCharge(){
   calls.push('getCharge');
   return {id:'charge12345678',order_id:FIRST,amount:10,currency:'MXN',status:'completed'};
  }
 };
 const vault=createVault({filePath:null,provider,pepper:'offline-f05-pin-pepper-over-32-characters'});
 const card=await vault.enroll(f.payerId,{
  tokenId:'token12345678',deviceSessionId:'device123456789',
  firstName:'Ana',lastName:'Prueba',email:'payer@example.com',consent:true
 });
 vault.setPin(f.payerId,'1234','payer-secret-1234567',
  (id,password)=>f.accounts.verifyPassword(id,password));
 calls.length=0;
 f.accounts.setPreferences(f.payerId,{alias:'Ana',whatsappReceipts:false});
 const request={id:FIRST,amount:1000,requesterId:'5215555550002',state:'PENDING'};
 const flow=createSavedCardFlow({
  journal,accounts:f.accounts,vault,enabled:true,
  requestStore:{getRequest:id=>id===FIRST?request:null},
  notify:async(...args)=>notifications.push(args)
 });
 const result=await flow.pay({
  accountId:f.payerId,requestId:FIRST,cardId:card.id,pin:'1234',
  deviceSessionId:'device123456789',consent:true,csrfVerified:true
 });
 assert.equal(result.state,'PAID');
 assert.deepEqual(calls,['getCard','charge','getCharge']);
 assert.equal(journal.listForAccount(f.payerId,f.accounts).length,1);
 assert.equal(journal.listForAccount(f.receiverId,f.accounts).length,1);
 assert.deepEqual(notifications.map(x=>x[0]),['5215555550002']);
});
