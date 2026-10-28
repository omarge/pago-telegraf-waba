'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {verifyF05}=require('../scripts/f05-verify-existing-payment');
const {createAccountService}=require('../src/accountService');
const {createVault}=require('../src/cardVault');
const {createStatementJournal}=require('../src/statementJournal');
const id='KPR-'+'A'.repeat(32);
const receiptId='charge_f05_1234567';
const wa='5215555550001';
const pepper='sandbox-f05-offline-pin-test-pepper-longer-than-32';
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f05-ro-'));
 const accountFile=path.join(dir,'accounts.json');
 const vaultFile=path.join(dir,'vault.json');
 const journalFile=path.join(dir,'statements.json');
 const accounts=createAccountService({filePath:accountFile});
 const session=accounts.register('payer@example.test','a-long-password-12345678');
 const accountId=accounts.getSession(session.token).accountId;
 const challenge=accounts.beginLink(session.token,session.csrf).code;
 assert.equal(accounts.bindFromWhatsApp(wa,challenge),true);
 const calls=[];
 let remote={
  id:receiptId,order_id:id,amount:10,currency:'MXN',
  status:'completed',customer_id:'customer_f05_1234567'
 };
 const provider={
  merchantId:'merchant_f05_12345',publicKey:'pk_fake',
  async createCustomer(){return {id:'customer_f05_1234567'};},
  async addCard(){return {id:'card_f05_1234567'};},
  async getCard(customer,cardId){return {id:cardId,customer_id:customer,
   card_number:'4444',brand:'mastercard',allows_charges:true};},
  async getCharge(customer,chargeId){
   calls.push({method:'GET',customer,chargeId});
   return remote;
  },
  async chargeSavedCard(){throw Error('F05 must never charge');}
 };
 const vault=createVault({filePath:vaultFile,pepper,provider});
 const journal=createStatementJournal({filePath:journalFile});
 const record={requestId:id,chargeId:receiptId,amountCents:1000,
  payerAccountId:accountId,requesterWaId:wa};
 return {dir,accountFile,vaultFile,journalFile,accounts,vault,journal,
  provider,calls,record,accountId,getRemote:()=>remote,setRemote:r=>remote=r};
}
async function prepare(f){
 await f.vault.enroll(f.accountId,{
  tokenId:'token_f05_abcdef123456',deviceSessionId:'device_f05_abcdef123456',
  firstName:'Sandbox',lastName:'User',email:'payer@example.test',consent:true
 });
 f.journal.recordCompleted(f.record);
 return {
  requestId:id,
  records:JSON.parse(fs.readFileSync(f.journalFile,'utf8')).records,
  accounts:createAccountService({filePath:f.accountFile}),
  vault:createVault({filePath:f.vaultFile,pepper,provider:f.provider}),
  journal:createStatementJournal({filePath:f.journalFile}),
  provider:f.provider
 };
}
test('F05 real evidence fixture: reads existing journal and verifies Openpay via one GET, no writes',async()=>{
 const f=fixture();
 try{
  const args=await prepare(f);
  const before=[f.accountFile,f.vaultFile,f.journalFile].map(p=>fs.readFileSync(p));
  const result=await verifyF05(args);
  assert.equal(result.status,'GREEN');
  assert.equal(result.providerGet,true);
  assert.equal(result.receipt,true);
  assert.equal(result.statement,true);
  assert.equal(result.amountCents,1000);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].method,'GET');
  assert.equal(f.calls[0].chargeId,receiptId);
  assert.deepEqual([f.accountFile,f.vaultFile,f.journalFile].map(p=>fs.readFileSync(p)),before);
 }finally{fs.rmSync(f.dir,{force:true,recursive:true});}
});
test('F05 rejects missing or duplicated request in journal before contacting provider',async()=>{
 const f=fixture();
 try{
  const args=await prepare(f);
  await assert.rejects(verifyF05({...args,records:[]}),/F05_JOURNAL_NOT_UNIQUE/);
  await assert.rejects(verifyF05({...args,records:[...args.records,...args.records]}),/F05_JOURNAL_NOT_UNIQUE/);
  assert.equal(f.calls.length,0);
 }finally{fs.rmSync(f.dir,{force:true,recursive:true});}
});
test('F05 reject mismatched Openpay status, amount, currency and order reference without extra requests',async()=>{
 const f=fixture();
 try{
  const args=await prepare(f),original=f.getRemote();
  for(const altered of [
   {status:'in_progress'},
   {amount:100},
   {currency:'USD'},
   {order_id:'KPR-'+'B'.repeat(32)},
   {id:'charge_another12345678'},
   {customer_id:'customer_unrelated12345'}
  ]){
   f.setRemote({...original,...altered});
   await assert.rejects(verifyF05(args),/F05_PROVIDER_MISMATCH/);
  }
  assert.equal(f.calls.length,6);
  assert.ok(f.calls.every(c=>c.method==='GET'));
 }finally{fs.rmSync(f.dir,{force:true,recursive:true});}
});
test('F05 fails closed when provider read fails, no secret error leaks',async()=>{
 const f=fixture();
 try{
  const args=await prepare(f);
  args.provider={...args.provider,getCharge:async()=>{throw Error('SECRET_PRIVATE_KEY_DO_NOT_EXPOSE');}};
  await assert.rejects(verifyF05(args),err=>{
   assert.equal(err.message,'F05_PROVIDER_GET_FAILED');
   return true;
  });
 }finally{fs.rmSync(f.dir,{force:true,recursive:true});}
});
test('F05 receipt and journal mismatch fail before any Openpay GET',async()=>{
 const f=fixture();
 try{
  const args=await prepare(f);
  const corrupted=args.records.map(x=>({...x,amountCents:9999}));
  await assert.rejects(verifyF05({...args,records:corrupted}),/F05_JOURNAL_INVALID/);
  assert.equal(f.calls.length,0);
 }finally{fs.rmSync(f.dir,{force:true,recursive:true});}
});
