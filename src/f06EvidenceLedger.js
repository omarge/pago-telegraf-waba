'use strict';
// R5 standalone, offline-only evidence ledger. No integration with live webhook.
// Private file holds Meta message references and phone destinations; never log it.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createDeliveryEvidence}=require('./f06DeliveryEvidence');
function createEvidenceLedger({filePath,appSecret,phoneId,testToOverride='',
 maxRecords=100}={}){
 if(typeof filePath!=='string'||!path.isAbsolute(filePath)||
    typeof appSecret!=='string'||appSecret.length<16)
  throw Error('F06_LEDGER_CONFIG');
 const model=createDeliveryEvidence({appSecret,phoneId,testToOverride,maxRecords});
 const key=crypto.createHmac('sha256',appSecret)
  .update('kashbit-waba-f06-ledger-v1').digest();
 const signature=payload=>crypto.createHmac('sha256',key)
  .update(JSON.stringify(payload)).digest('hex');
 const fileDir=path.dirname(filePath);
 function reload(){
  if(!fs.existsSync(filePath))return;
  const stats=fs.lstatSync(filePath);
  if(!stats.isFile()||stats.size>1048576||
     (stats.mode&0o077)!==0)throw Error('F06_LEDGER_UNSAFE_FILE');
  let saved;
  try{saved=JSON.parse(fs.readFileSync(filePath,'utf8'));}
  catch(_error){throw Error('F06_LEDGER_INVALID');}
  if(saved?.version!==1||!saved.payload||
      typeof saved.mac!=='string'||!/^[0-9a-f]{64}$/.test(saved.mac))
   throw Error('F06_LEDGER_INVALID');
  const expected=Buffer.from(signature(saved.payload),'hex');
  const actual=Buffer.from(saved.mac,'hex');
  if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))
   throw Error('F06_LEDGER_INTEGRITY_FAILURE');
  model.restoreSnapshot(saved.payload);
 }
 function persist(){
  fs.mkdirSync(fileDir,{mode:0o700,recursive:true});
  const payload=model.exportSnapshot();
  const tmp=filePath+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  const data=JSON.stringify({version:1,payload,mac:signature(payload)});
  try{
   fs.writeFileSync(tmp,data,{mode:0o600,flag:'wx'});
   fs.renameSync(tmp,filePath);
  }catch(_error){
   try{fs.unlinkSync(tmp);}catch(_ignored){}
   throw Error('F06_LEDGER_WRITE_FAILED');
  }
 }
 function apply(method,args){
  const previous=model.exportSnapshot();
  const result=model[method](args);
  const changed=method==='recordAcceptance'?!result.duplicate:result.updated>0;
  if(changed){
   try{persist();}
   catch(error){model.restoreSnapshot(previous);throw error;}
  }
  return result;
 }
 reload();
 return Object.freeze({
  recordAcceptance:args=>apply('recordAcceptance',args),
  ingestSignedStatus:args=>apply('ingestSignedStatus',args),
  summary:()=>model.summary(),
  isLiveIntegrated:false
 });
}
module.exports={createEvidenceLedger};
