'use strict';
// Local-only F04 Openpay Sandbox certification harness.
// No external network requests occur until a signed-in operator explicitly
// submits the saved-card payment form with PIN and amount consent.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const express=require('express');

const AMOUNT_CENTS=1000;
const TEST_HOST='127.0.0.1';
const TEST_PORT=18768;
const ACCOUNTS_FILE=path.join(process.cwd(),'data','waba-accounts.json');

function eligibleAccounts({accounts,vault,accountRecords}){
 if(!Array.isArray(accountRecords))throw Error('Invalid account store');
 return accountRecords.filter(record=>{
  if(typeof record?.id!=='string'||!(/^\d{8,20}$/).test(String(record.waId||'')))return false;
  if(accounts.getLinkedWhatsApp(record.id)!==record.waId)return false;
  let profile;
  try{profile=vault.profile(record.id);}catch(_e){return false;}
  if(!profile.pinConfigured||!profile.pinEnabled||!profile.enrollmentEnabled)return false;
  return profile.cards.some(card=>{
   const owned=vault.ownedCard(record.id,card.id);
   return owned&&owned.merchantId===vault.provider?.merchantId;
  });
 });
}
function createLocalSandboxHarness({accounts,vault,journal,requesterWaId,
  enabled=false,notify=async()=>{},randomBytes=crypto.randomBytes}={}){
 if(!accounts||!vault||!journal||!/^\d{8,20}$/.test(String(requesterWaId||'')))
  throw Error('Missing local Sandbox harness dependencies');
 const id='KPR-'+randomBytes(16).toString('hex').toUpperCase();
 const request={
  id,requesterId:requesterWaId,payerId:'f04-local-sandbox',
  amount:AMOUNT_CENTS,state:'PENDING',created:Date.now()
 };
 const requestStore={getRequest:requested=>requested===id?request:null};
 const {createAccountRouter}=require('../src/accountRoutes');
 const app=express();
 app.disable('x-powered-by');
 app.use('/pay/app',createAccountRouter({
  service:accounts,vault,requestStore,journal,notifier:notify,savedCardEnabled:enabled
 }));
 return {app,request,requestId:id,requestStore};
}
function localPortBusy(port){
 return new Promise((resolve,reject)=>{
  const socket=net.connect({host:TEST_HOST,port});
  socket.setTimeout(500);
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('timeout',()=>{socket.destroy();resolve(true);});
  socket.once('error',error=>{
   socket.destroy();
   if(error.code==='ECONNREFUSED')resolve(false);
   else reject(error);
  });
 });
}
async function main({args=process.argv.slice(2),env=process.env,log=console}={}){
 const dry=args.includes('--preflight');
 const approved=args.includes('--authorize-sandbox-10-mxn');
 if(!dry&&!approved)throw Error('Use --preflight, or explicit --authorize-sandbox-10-mxn');
 if(dry&&approved)throw Error('Choose exactly one mode');
 // The process must be launched from the project root; never search for
 // .env or other secrets outside the project.
 require('dotenv').config();
 const {accountService}=require('../src/accountService');
 const {createVault}=require('../src/cardVault');
 const {createSandboxProvider}=require('../src/openpayCardProvider');
 if(env.WABA_CARD_ENROLL_SANDBOX!=='1')throw Error('Sandbox enrollment must be enabled');
 if(typeof env.KASHBIT_PIN_PEPPER!=='string'||env.KASHBIT_PIN_PEPPER.length<32)
  throw Error('PIN environment is not ready');
 const provider=createSandboxProvider();
 const vault=createVault({provider});
 if(!fs.existsSync(ACCOUNTS_FILE))throw Error('No local web accounts');
 const records=JSON.parse(fs.readFileSync(ACCOUNTS_FILE,'utf8')).accounts;
 const eligible=eligibleAccounts({accounts:accountService,vault,accountRecords:records});
 log.log('F04_ELIGIBLE_LINKED_ACCOUNTS='+eligible.length);
 log.log('F04_SAVED_CARD_CHARGES='+(env.WABA_SAVED_CARD_PAY_SANDBOX==='1'?'ENABLED':'DISABLED'));
 if(eligible.length!==1)throw Error('F04 needs exactly one eligible linked account; no test request created');
 const profile=vault.profile(eligible[0].id);
 log.log('F04_PIN=READY');
 log.log('F04_CARD='+profile.cards.map(c=>String(c.brand).slice(0,30)+' ****'+String(c.last4)).join(', '));
 if(dry){
  log.log('F04_PREFLIGHT=GREEN_READ_ONLY');
  return {mode:'preflight',eligible:eligible.length};
 }
 if(env.WABA_SAVED_CARD_PAY_SANDBOX!=='1')throw Error('Saved-card Sandbox charge disabled');
 if(await localPortBusy(8765))throw Error('Stop npm start first: avoid concurrent access to local data');
 const {statementJournal}=require('../src/statementJournal');
 // A single local request exists in memory. No test WhatsApp messages:
 // the requester is the test account's already-linked WAID, and notify
 // is deliberately a no-op until Meta approves the display name.
 const harness=createLocalSandboxHarness({
  accounts:accountService,vault,journal:statementJournal,
  requesterWaId:eligible[0].waId,enabled:true,notify:async()=>{}
 });
 const server=await new Promise((resolve,reject)=>{
  const s=harness.app.listen(TEST_PORT,TEST_HOST,()=>resolve(s));
  s.once('error',reject);
 });
 log.log('F04_LOCAL_ONLY=YES');
 log.log('F04_SANDBOX_AMOUNT_MXN=10.00');
 log.log('F04_CHARGES_AUTOMATIC=NO');
 log.log('F04_META_NOTIFICATIONS=DISABLED');
 log.log('F04_URL=http://'+TEST_HOST+':'+server.address().port+
  '/pay/app/pay/'+harness.requestId);
 return {mode:'sandbox',harness,server};
}
if(require.main===module){
 main().catch(_error=>{
  // This is a local tool; print a generic message rather than any SDK
  // response that might hold token, card or customer data.
  console.error('F04 local preflight/start failed; check local configuration and running ports.');
  process.exitCode=1;
 });
}
module.exports={AMOUNT_CENTS,TEST_HOST,TEST_PORT,eligibleAccounts,createLocalSandboxHarness,main};
