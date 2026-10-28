'use strict';
// R3 offline-only single-writer durable payer claim, not a payment store.
// NEVER register directly at startup. No BusinessOS, Openpay or Meta calls.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ORDER=/^KPR-[A-F0-9]{32}$/;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TTL=15*60*1000;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function createPayerClaimLedger({filePath,integrityKey,requestStore,now=()=>Date.now()}={}){
 if(typeof filePath!=='string'||!path.isAbsolute(filePath)||
    typeof integrityKey!=='string'||integrityKey.length<32||
    !requestStore||typeof requestStore.getRequest!=='function')
  throw Error('R3_CONFIG_INVALID');
 const directory=path.dirname(filePath);
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 if(fs.lstatSync(directory).mode&0o077)throw Error('R3_DIRECTORY_UNSAFE');
 // No accidental multi-process use. A stale lock after crash requires
 // operator review, never an unsafe automatic takeover.
 const lock=filePath+'.lock';
 let lockFd;
 try{lockFd=fs.openSync(lock,'wx',0o600);}
 catch(_e){throw Error('R3_WRITER_LOCKED');}
 let closed=false;
 const records=new Map(),views=new Map();
 const key=crypto.createHmac('sha256',integrityKey).update('waba-businessos-payer-r3-v1').digest();
 const mac=body=>crypto.createHmac('sha256',key).update(JSON.stringify(body)).digest('hex');
 function valid(record){
  return record&&ORDER.test(record.id||'')&&
   Number.isSafeInteger(record.amount)&&record.amount>0&&
   typeof record.requesterId==='string'&&record.requesterId.length>0&&
   record.requesterId.length<=128&&
   /^[a-f0-9]{64}$/.test(record.challengeHash||'')&&
   Number.isSafeInteger(record.expiresAt)&&record.expiresAt>0&&
   (record.boundAccountId===null||ACCOUNT.test(record.boundAccountId||''));
 }
 function snapshot(){return {version:1,entries:[...records.values()].map(v=>({...v}))};}
 function load(){
  if(!fs.existsSync(filePath))return;
  const stat=fs.lstatSync(filePath);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>1048576)
   throw Error('R3_FILE_UNSAFE');
  let obj;
  try{obj=JSON.parse(fs.readFileSync(filePath,'utf8'));}
  catch(_e){throw Error('R3_FILE_INVALID');}
  if(obj?.version!==1||typeof obj?.signature!=='string'||
    !/^[a-f0-9]{64}$/.test(obj.signature)||obj.data?.version!==1||
    !Array.isArray(obj.data.entries)||obj.data.entries.length>1000)
   throw Error('R3_FILE_INVALID');
  const expected=Buffer.from(mac(obj.data),'hex');
  const actual=Buffer.from(obj.signature,'hex');
  if(!crypto.timingSafeEqual(expected,actual))throw Error('R3_FILE_INTEGRITY');
  for(const rec of obj.data.entries){
   if(!valid(rec)||records.has(rec.id))throw Error('R3_FILE_INVALID');
   records.set(rec.id,{...rec});
  }
 }
 function persist(){
  const data=snapshot(),out=JSON.stringify({version:1,data,signature:mac(data)});
  if(Buffer.byteLength(out)>1048576)throw Error('R3_CAPACITY');
  const temp=filePath+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  let fd;
  try{
   fd=fs.openSync(temp,'wx',0o600);
   fs.writeFileSync(fd,out);
   fs.fsyncSync(fd);
   fs.closeSync(fd);fd=null;
   fs.renameSync(temp,filePath);
   const dirFd=fs.openSync(directory,'r');
   try{fs.fsyncSync(dirFd);}finally{fs.closeSync(dirFd);}
  }catch(_e){
   if(fd!==null&&fd!==undefined)try{fs.closeSync(fd);}catch(_ignored){}
   try{fs.unlinkSync(temp);}catch(_ignored){}
   throw Error('R3_PERSIST_FAILED');
  }
 }
 function anchor(requestId){
  const r=requestStore.getRequest(requestId);
  if(!r||r.id!==requestId||r.state!=='PENDING'||
    !Number.isSafeInteger(r.amount)||r.amount<=0||
    typeof r.requesterId!=='string'||!r.requesterId||r.requesterId.length>128||
    (r.payerAccountId!=null&&r.payerAccountId!==''))return null;
  return r;
 }
 function issue({requestId}={}){
  if(closed)throw Error('R3_CLOSED');
  if(!ORDER.test(requestId||''))return {state:'NOT_FOUND'};
  const r=anchor(requestId);
  if(!r)return {state:'NOT_FOUND'};
  const previous=records.get(requestId);
  if(previous?.boundAccountId)return {state:'ALREADY_CLAIMED'};
  if(previous&&now()<previous.expiresAt)return {state:'ALREADY_ISSUED'};
  if(records.size>=1000&&!previous)return {state:'CAPACITY'};
  const claimSecret=crypto.randomBytes(32).toString('base64url');
  const record={id:r.id,amount:r.amount,requesterId:r.requesterId,
   challengeHash:hash(claimSecret),expiresAt:now()+TTL,boundAccountId:null};
  records.set(requestId,record);
  try{persist();}
  catch(e){if(previous)records.set(requestId,previous);else records.delete(requestId);throw e;}
  // This one-time secret is returned ONLY to the trusted issue caller.
  // Never emit it from GET or log it; send it only through an authorized
  // HTTPS flow for the intended payer.
  return {state:'ISSUED',claimSecret,expiresAt:record.expiresAt};
 }
 function claim({requestId,claimSecret,accountId,csrfVerified,whatsappLinked}={}){
  if(closed)throw Error('R3_CLOSED');
  if(csrfVerified!==true||whatsappLinked!==true||
     !ACCOUNT.test(accountId||'')||!ORDER.test(requestId||''))
   return {state:'DENIED'};
  const r=anchor(requestId),record=records.get(requestId);
  if(!r||!record)return {state:'NOT_FOUND'};
  if(record.boundAccountId)return {state:'ALREADY_CLAIMED'};
  if(now()>=record.expiresAt)return {state:'EXPIRED'};
  if(r.amount!==record.amount||r.requesterId!==record.requesterId)
   return {state:'REQUEST_CHANGED'};
  if(typeof claimSecret!=='string'||claimSecret.length<30||claimSecret.length>128)
   return {state:'DENIED'};
  const supplied=Buffer.from(hash(claimSecret),'hex');
  const expected=Buffer.from(record.challengeHash,'hex');
  if(!crypto.timingSafeEqual(supplied,expected))return {state:'DENIED'};
  const replacement={...record,boundAccountId:accountId,challengeHash:hash('used:'+record.challengeHash)};
  records.set(requestId,replacement);
  try{persist();}catch(e){records.set(requestId,record);throw e;}
  return {state:'CLAIMED'};
 }
 function bindingFor(requestId){
  if(closed)throw Error('R3_CLOSED');
  const record=records.get(requestId);
  if(!record?.boundAccountId)return null;
  const r=anchor(requestId);
  if(!r||r.amount!==record.amount||r.requesterId!==record.requesterId)
   return null;
  return record.boundAccountId;
 }
 // Stable object identity for R2's optimistic recheck after async resolution.
 // Never patch the original payment request or use an unbound request to execute.
 function getRequest(requestId){
  const base=requestStore.getRequest(requestId);
  if(!base||base.id!==requestId)return null;
  const bound=bindingFor(requestId);
  let view=views.get(requestId);
  if(!view){view={};views.set(requestId,view);}
  Object.assign(view,base);
  view.payerAccountId=bound;
  return view;
 }
 function close(){
  if(closed)return;
  closed=true;
  fs.closeSync(lockFd);
  fs.unlinkSync(lock);
 }
 try{load();}
 catch(e){close();throw e;}
 return Object.freeze({issue,claim,bindingFor,getRequest,close,
  isDurableClaimLedger:true,isDurablePaymentRequestStore:false});
}
module.exports={createPayerClaimLedger};
