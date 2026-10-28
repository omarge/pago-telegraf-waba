'use strict';
// F06: zero-network / zero-write WhatsApp bilateral readiness preflight.
// Never sends Meta messages, charges Openpay, or exposes secrets or WA IDs.
const fs=require('node:fs');
const path=require('node:path');

function normalizedDestination(wa){
 if(typeof wa!=='string'||!/^\d{8,20}$/.test(wa))return null;
 // Match src/waba.js normalizePhone() for a Mexican WhatsApp number.
 if(wa.startsWith('521')&&wa.length===13)return '52'+wa.slice(3);
 return wa;
}

function assess({accounts=[],env={},getLinkedWhatsApp}={}){
 if(!Array.isArray(accounts)||typeof getLinkedWhatsApp!=='function')
  throw Error('F06_INVALID_INPUT');
 const seen=new Set();
 const eligible=[];
 for(const account of accounts){
  if(!account||typeof account.id!=='string'||typeof account.waId!=='string')continue;
  const destination=normalizedDestination(account.waId);
  if(!destination||getLinkedWhatsApp(account.id)!==account.waId)continue;
  if(seen.has(account.id))continue;
  seen.add(account.id);
  eligible.push(destination);
 }
 const unique=[...new Set(eligible)];
 // Do not echo environment values or any personal identifying information.
 const status=!env.WABA_TOKEN||!env.WABA_PHONE_ID?
  'BLOCKED_META_CONFIG_MISSING':
  !!env.WABA_TEST_TO?
  'BLOCKED_TEST_TO_REDIRECT':
  unique.length<2?
  'BLOCKED_NEED_TWO_DISTINCT_WHATSAPP_ACCOUNTS':
  'CONFIG_READY_META_UNVERIFIED';
 return Object.freeze({
  status,
  linkedAccounts:eligible.length,
  distinctDestinations:unique.length,
  testRedirectActive:!!env.WABA_TEST_TO,
  metaApproval:'NOT_VERIFIED',
  deliveredMessages:0,
  charges:0
 });
}
function run({root=process.cwd(),env=process.env,log=console}={}){
 require('dotenv').config({path:path.join(root,'.env')});
 const {createAccountService}=require('../src/accountService');
 const file=path.join(root,'data','waba-accounts.json');
 if(!fs.existsSync(file))throw Error('F06_ACCOUNTS_FILE_MISSING');
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!Array.isArray(saved?.accounts))throw Error('F06_ACCOUNTS_INVALID');
 const accounts=createAccountService({filePath:file});
 const result=assess({
  accounts:saved.accounts,env,getLinkedWhatsApp:id=>accounts.getLinkedWhatsApp(id)
 });
 log.log('F06_MODE=READ_ONLY');
 log.log('F06_LINKED_ACCOUNTS='+result.linkedAccounts);
 log.log('F06_DISTINCT_DESTINATIONS='+result.distinctDestinations);
 log.log('F06_TEST_TO_OVERRIDE='+(result.testRedirectActive?'ON':'OFF'));
 log.log('F06_META_APPROVAL=NOT_VERIFIED');
 log.log('F06_META_MESSAGES_SENT=0');
 log.log('F06_OPENPAY_CHARGES=0');
 log.log('F06_ROUTING_PREFLIGHT='+result.status);
 return result;
}
if(require.main===module){
 try{
  const result=run();
  if(result.status!=='CONFIG_READY_META_UNVERIFIED')process.exitCode=2;
 }catch(_error){
  console.error('F06_ROUTING_PREFLIGHT=ERROR_READ_ONLY');
  process.exitCode=1;
 }
}
module.exports={normalizedDestination,assess,run};
