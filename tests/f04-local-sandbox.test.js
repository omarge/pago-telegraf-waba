'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createVault}=require('../src/cardVault');
const {createAccountService}=require('../src/accountService');
const {createStatementJournal}=require('../src/statementJournal');
const {eligibleAccounts,createLocalSandboxHarness,AMOUNT_CENTS,TEST_HOST}=require('../scripts/f04-local-sandbox');

const PEPPER='offline-only-pin-pepper-over-32-characters';
const requester='5215555550001';
const accPassword='user-password-0123456789';
function fixture(){
 const accounts=createAccountService({filePath:null});
 const web=accounts.register('user@example.test',accPassword);
 const accountId=accounts.getSession(web.token).accountId;
 const challenge=accounts.beginLink(web.token,web.csrf);
 assert.equal(accounts.bindFromWhatsApp(requester,challenge.code),true);
 const calls=[];
 const provider={
  merchantId:'merchant123456',publicKey:'pk_test',
  async createCustomer(){return {id:'customer123456'};},
  async addCard(){return {id:'card12345678'};},
  async getCard(customer,id){
   calls.push('getCard');
   return {id,customer_id:customer,brand:'mastercard',card_number:'4444',allows_charges:true};
  },
  async chargeSavedCard(){
   calls.push('CHARGE');throw Error('This test must not charge');
  },
  async getCharge(){calls.push('getCharge');throw Error('No charge has been made');}
 };
 const vault=createVault({filePath:null,pepper:PEPPER,provider});
 const journal=createStatementJournal({filePath:null});
 return {accounts,web,accountId,vault,journal,provider,calls};
}
async function setup(f){
 await f.vault.enroll(f.accountId,{
  tokenId:'token_f04_0123456',deviceSessionId:'device_f04_0123456',
  firstName:'Test',lastName:'Sandbox',email:'user@example.test',consent:true
 });
 f.vault.setPin(f.accountId,'1234',accPassword,(id,pw)=>f.accounts.verifyPassword(id,pw));
 f.calls.length=0;
}
test('F04 local harness is scoped to actual linked owner with saved card and PIN',async()=>{
 const f=fixture();
 const record={id:f.accountId,waId:requester};
 assert.equal(eligibleAccounts({accounts:f.accounts,vault:f.vault,accountRecords:[record]}).length,0);
 await setup(f);
 assert.equal(eligibleAccounts({accounts:f.accounts,vault:f.vault,accountRecords:[record]}).length,1);
 assert.equal(eligibleAccounts({accounts:f.accounts,vault:f.vault,accountRecords:[{...record,waId:'5215555551111'}]}).length,0);
});

test('F04 local harness serves exactly one $10 Sandbox request, no charges while flag off',async()=>{
 const f=fixture();await setup(f);
 const h=createLocalSandboxHarness({
  accounts:f.accounts,vault:f.vault,journal:f.journal,requesterWaId:requester,enabled:false
 });
 assert.equal(h.request.amount,AMOUNT_CENTS);
 assert.equal(h.request.requesterId,requester);
 assert.equal(h.request.state,'PENDING');
 assert.equal(TEST_HOST,'127.0.0.1');
 const server=await new Promise(resolve=>{const s=h.app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  let response=await fetch(base+'/pay/app/pay/'+h.requestId,{redirect:'manual'});
  assert.equal(response.status,303);
  response=await fetch(base+'/pay/app/pay/'+h.requestId,{
   redirect:'manual',headers:{Cookie:'kashbit_web_session='+f.web.token}
  });
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/Pago con tarjeta guardada Sandbox no habilitado/);
  assert.doesNotMatch(html,/name="pin"/);
  assert.equal(f.calls.length,0);
  assert.equal(f.journal.listForAccount(f.accountId,f.accounts).length,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('F04 local harness does not emit WhatsApp notifications or create real charges by default',async()=>{
 const f=fixture();await setup(f);
 const h=createLocalSandboxHarness({accounts:f.accounts,vault:f.vault,journal:f.journal,requesterWaId:requester});
 const result=await new Promise(resolve=>{
  const s=h.app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const resp=await fetch('http://127.0.0.1:'+result.address().port+'/pay/app/pay/'+h.requestId,{
   method:'POST',redirect:'manual',headers:{Cookie:'kashbit_web_session='+f.web.token,
    'Content-Type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({
    _csrf:f.web.csrf,cardId:'card12345678',pin:'1234',deviceSessionId:'device_test_1234',consent:'yes'
   })
  });
  assert.equal(resp.status,400);
  assert.match(await resp.text(),/DISABLED/);
  assert.equal(f.calls.length,0);
  assert.equal(h.request.state,'PENDING');
 }finally{await new Promise(resolve=>result.close(resolve));}
});
