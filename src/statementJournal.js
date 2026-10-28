'use strict';
const fs=require('node:fs');
const path=require('node:path');
const DEFAULT_PATH=path.join(process.cwd(),'data','waba-statements.json');

function createStatementJournal({filePath=DEFAULT_PATH,now=()=>Date.now()}={}){
 let records=[];
 if(filePath && fs.existsSync(filePath)){
  const saved=JSON.parse(fs.readFileSync(filePath,'utf8'));
  if(saved?.version!==1 || !Array.isArray(saved.records))throw Error('Invalid statement journal');
  records=saved.records;
 }
 function persist(){
  if(!filePath)return;
  fs.mkdirSync(path.dirname(filePath),{recursive:true,mode:0o700});
  const tmp=filePath+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:1,records}),{mode:0o600});
  fs.renameSync(tmp,filePath);
 }
 function recordCompleted(data){
  const {requestId,chargeId,amountCents,payerAccountId,requesterWaId}=data||{};
  if(typeof requestId!=='string'||!/^KPR-[A-F0-9]{32}$/.test(requestId)||
     typeof chargeId!=='string'||!(/^[A-Za-z0-9_-]{8,100}$/).test(chargeId)||
     typeof payerAccountId!=='string'||!(/^[A-Za-z0-9_-]{8,100}$/).test(payerAccountId)||
     !Number.isSafeInteger(amountCents)||amountCents<=0||
     typeof requesterWaId!=='string'||!(/^\d{8,20}$/).test(requesterWaId))
   throw Error('Invalid verified payment metadata');
  const existing=records.find(r=>r.requestId===requestId || r.chargeId===chargeId);
  if(existing){
   if(existing.requestId!==requestId||existing.chargeId!==chargeId||
      existing.payerAccountId!==payerAccountId||existing.amountCents!==amountCents)
    throw Error('Payment reference conflict');
   return {...existing};
  }
  const record={requestId,chargeId,payerAccountId,requesterWaId,
   amountCents,currency:'MXN',status:'completed',source:'openpay_saved_card_sandbox',
   completedAt:now()};
  records.push(record);
  try{persist();}catch(error){records.pop();throw error;}
  return {...record};
 }
 function listForAccount(accountId,accounts){
  if(typeof accountId!=='string'||!accounts||typeof accounts.getLinkedWhatsApp!=='function')
   return [];
  const wa=accounts.getLinkedWhatsApp(accountId);
  return records.filter(r=>r.payerAccountId===accountId||(wa&&r.requesterWaId===wa))
   .map(r=>({
    requestId:r.requestId,chargeId:r.chargeId,amountCents:r.amountCents,
    currency:r.currency,status:r.status,source:r.source,completedAt:r.completedAt,
    direction:r.payerAccountId===accountId?'PAGO':'COBRO'
   })).sort((a,b)=>b.completedAt-a.completedAt);
 }
 function receiptForAccount(accountId,requestId,accounts){
  return listForAccount(accountId,accounts).find(r=>r.requestId===requestId)||null;
 }
 return {recordCompleted,listForAccount,receiptForAccount};
}
const statementJournal=createStatementJournal();
module.exports={createStatementJournal,statementJournal};
