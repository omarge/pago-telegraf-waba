'use strict';
// F08 UAT readiness: READ ONLY. Never opens a socket, contacts Meta/Openpay,
// changes env values, uploads credentials, executes charges or deploys.
function assessUat({
 env={},
 metaNameStatus='NOT_CHECKED',
 incomingWebhookSignatureEnforced=false,
 paymentRequestsDurable=false,
 legacyEndpointDisabled=false,
 operatorApproved=false
}={}){
 const blockers=[];
 if(metaNameStatus!=='APPROVED'&&metaNameStatus!=='AVAILABLE_WITHOUT_REVIEW')
  blockers.push('BLOCKED_META_NAME_NOT_APPROVED_OR_UNVERIFIED');
 if(!!env.WABA_TEST_TO)blockers.push('BLOCKED_TEST_DESTINATION_OVERRIDE');
 if(!incomingWebhookSignatureEnforced)
  blockers.push('BLOCKED_PUBLIC_WEBHOOK_SIGNATURE_NOT_ENFORCED');
 if(!paymentRequestsDurable)
  blockers.push('BLOCKED_INMEMORY_PAYMENT_REQUESTS');
 if(!legacyEndpointDisabled)
  blockers.push('BLOCKED_LEGACY_CHARGE_ROUTE');
 if(!operatorApproved)blockers.push('BLOCKED_NO_DEPLOY_APPROVAL');
 const result=Object.freeze({
  status:blockers.length?'PUBLIC_UAT_NO_GO':'CONFIG_PRECHECK_ONLY',
  blockers:Object.freeze(blockers),
  outboundMessages:0,providerCharges:0,
  notes:'CONFIG_PRECHECK_ONLY never proves live Meta delivery or payment durability'
 });
 return result;
}
function run({env=process.env,log=console}={}){
 const result=assessUat({
  env,metaNameStatus:'NOT_CHECKED',
  // Current public WABA webhook acknowledges before verifying HMAC.
  incomingWebhookSignatureEnforced:false,
  // src/store.js still keeps payment requests in an in-memory Map.
  paymentRequestsDurable:false,
  // F08 disables the legacy route by default in public startup.
  legacyEndpointDisabled:true,
  operatorApproved:false
 });
 log.log('F08_MODE=READ_ONLY');
 log.log('F08_SCOPE=HAPPY_PATH_SANDBOX');
 log.log('F08_UAT_GATE='+result.status);
 log.log('F08_BLOCKERS='+result.blockers.join(','));
 log.log('F08_META_MESSAGES_SENT=0');
 log.log('F08_OPENPAY_CHARGES=0');
 log.log('F08_BUSINESSOS_WRITES=0');
 return result;
}
if(require.main===module){
 require('dotenv').config();
 try{const gate=run();if(gate.status!=='CONFIG_PRECHECK_ONLY')process.exitCode=2;}
 catch(_error){console.error('F08_UAT_GATE=READ_ONLY_ERROR');process.exitCode=1;}
}
module.exports={assessUat,run};
