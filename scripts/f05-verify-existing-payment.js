'use strict';
// Read-only F05 reconciliation of one completed Openpay Sandbox card payment.
// Does not create charges, mutate the ledger, send WhatsApp, or write any files.
const fs=require('node:fs');
const path=require('node:path');
const REQUEST_RE=/^KPR-[A-F0-9]{32}$/;
const SAFE_ID_RE=/^[A-Za-z0-9_-]{8,100}$/;

async function verifyF05({requestId,records,accounts,vault,journal,provider}={}){
 if(typeof requestId!=='string'||!REQUEST_RE.test(requestId))throw Error('F05_INVALID_REQUEST');
 if(!Array.isArray(records)||!accounts||!vault||!journal||!provider||typeof provider.getCharge!=='function')
  throw Error('F05_INVALID_DEPENDENCIES');
 const matched=records.filter(record=>record?.requestId===requestId);
 if(matched.length!==1)throw Error('F05_JOURNAL_NOT_UNIQUE');
 const record=matched[0];
 if(!SAFE_ID_RE.test(record.chargeId)||!SAFE_ID_RE.test(record.payerAccountId)||
  record.amountCents!==1000||record.currency!=='MXN'||
  record.status!=='completed'||record.source!=='openpay_saved_card_sandbox'||
  !/^\d{8,20}$/.test(String(record.requesterWaId||''))||
  !Number.isFinite(record.completedAt))throw Error('F05_JOURNAL_INVALID');
 const receipt=journal.receiptForAccount(record.payerAccountId,requestId,accounts);
 if(!receipt||receipt.chargeId!==record.chargeId||
   receipt.direction!=='PAGO'||receipt.amountCents!==1000||
   receipt.currency!=='MXN'||receipt.status!=='completed')
  throw Error('F05_RECEIPT_INCONSISTENT');
 const statement=journal.listForAccount(record.payerAccountId,accounts);
 if(statement.filter(entry=>entry.requestId===requestId&&entry.chargeId===record.chargeId).length!==1)
  throw Error('F05_STATEMENT_INCONSISTENT');
 const own=vault.profile(record.payerAccountId).cards
  .map(card=>vault.ownedCard(record.payerAccountId,card.id))
  .filter(card=>card?.merchantId===provider.merchantId&&SAFE_ID_RE.test(card.customerId));
 const customers=[...new Set(own.map(card=>card.customerId))];
 if(customers.length!==1)throw Error('F05_CUSTOMER_AMBIGUOUS');
 let fromProvider;
 try{fromProvider=await provider.getCharge(customers[0],record.chargeId);}
 catch(_error){throw Error('F05_PROVIDER_GET_FAILED');}
 if(!fromProvider||
  fromProvider.id!==record.chargeId||
  fromProvider.order_id!==requestId||
  fromProvider.currency!=='MXN'||
  !Number.isFinite(Number(fromProvider.amount))||
  Math.round(Number(fromProvider.amount)*100)!==1000||
  fromProvider.status!=='completed'||
  (fromProvider.customer_id&&fromProvider.customer_id!==customers[0]))
  throw Error('F05_PROVIDER_MISMATCH');
 return Object.freeze({
  status:'GREEN',
  amountCents:record.amountCents,
  source:'openpay_saved_card_sandbox',
  journal:true,
  statement:true,
  receipt:true,
  providerGet:true,
  matchedCards:own.length,
  cardBrands:own.map(card=>({brand:card.brand,last4:card.last4}))
 });
}

async function run(argv=process.argv.slice(2),log=console){
 if(argv.length!==2||argv[0]!=='--request-id'||!REQUEST_RE.test(argv[1]))
  throw Error('F05_USAGE');
 require('dotenv').config();
 const requestId=argv[1];
 const {createAccountService}=require('../src/accountService');
 const {createVault}=require('../src/cardVault');
 const {createStatementJournal}=require('../src/statementJournal');
 const {createSandboxProvider}=require('../src/openpayCardProvider');
 const file=path.join(process.cwd(),'data','waba-statements.json');
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 if(data?.version!==1||!Array.isArray(data.records))throw Error('F05_JOURNAL_FORMAT');
 const accounts=createAccountService();
 // Explicit true enables GET access regardless of any financial charge flag.
 // This script calls only getCharge() on the provider.
 const provider=createSandboxProvider({enabled:true});
 const vault=createVault({provider});
 const journal=createStatementJournal();
 const result=await verifyF05({
  requestId,records:data.records,accounts,vault,journal,provider
 });
 log.log('F05_JOURNAL=GREEN');
 log.log('F05_STATEMENT=GREEN');
 log.log('F05_RECEIPT=GREEN');
 log.log('F05_OPENPAY_SANDBOX_GET=GREEN');
 log.log('F05_AMOUNT_MXN=10.00');
 log.log('F05_METHOD=GET_ONLY');
 log.log('F05_NEW_CHARGES=0');
 log.log('F05_NOTIFICATIONS=NOT_TESTED');
 log.log('F05_RECONCILIATION=GREEN_READ_ONLY');
 return result;
}
if(require.main===module){
 run().catch(error=>{
  const known=/^F05_[A-Z_]+$/.test(error?.message||'')?error.message:'F05_UNEXPECTED_ERROR';
  console.error('F05_RECONCILIATION=RED');
  console.error('F05_STAGE='+known);
  process.exitCode=1;
 });
}
module.exports={verifyF05,run};
