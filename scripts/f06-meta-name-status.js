'use strict';
// F06: diagnostic-only Meta display-name status via single HTTPS GET.
// No outbound messages, charges, modifications or secrets in output.
const https=require('node:https');
const STATES=new Set([
 'APPROVED','AVAILABLE_WITHOUT_REVIEW','PENDING_REVIEW','DECLINED','EXPIRED','NONE'
]);
const APPROVED=new Set(['APPROVED','AVAILABLE_WITHOUT_REVIEW']);

function readMetaNameStatus({token,phoneId,transport=https}={}){
 if(typeof token!=='string'||token.length<16||
  typeof phoneId!=='string'||!/^\d{8,24}$/.test(phoneId))
  return Promise.reject(Error('F06_META_CONFIG_MISSING'));
 return new Promise((resolve,reject)=>{
  let finished=false;
  const finish=(err,value)=>{
   if(finished)return;
   finished=true;
   if(err)reject(err);
   else resolve(value);
  };
  // Version deliberately explicit and independent from the legacy send API.
  const opts={
   hostname:'graph.facebook.com',port:443,method:'GET',
   path:'/v26.0/'+phoneId+'?fields=name_status',
   timeout:10000,
   headers:{Authorization:'Bearer '+token,Accept:'application/json'}
  };
  const req=transport.request(opts,res=>{
   let raw='',size=0;
   res.on('data',part=>{
    size+=Buffer.byteLength(part);
    if(size>16384){
     finish(Error('F06_META_RESPONSE_TOO_LARGE'));
     req.destroy();
    }else if(!finished)raw+=part;
   });
   res.on('end',()=>{
    if(finished)return;
    if(res.statusCode!==200)return finish(Error('F06_META_GET_UNAVAILABLE'));
    let data;
    try{data=JSON.parse(raw);}
    catch(_e){return finish(Error('F06_META_BAD_JSON'));}
    if(!data||data.error||!STATES.has(data.name_status))
     return finish(Error('F06_META_NAME_STATUS_UNAVAILABLE'));
    finish(null,data.name_status);
   });
   res.on('error',()=>finish(Error('F06_META_READ_FAILED')));
  });
  req.on('timeout',()=>{finish(Error('F06_META_READ_TIMEOUT'));req.destroy();});
  req.on('error',()=>finish(Error('F06_META_READ_FAILED')));
  req.end();
 });
}
function classify(status){
 return APPROVED.has(status)?
  'NAME_READY_DELIVERY_UNVERIFIED':
  status==='PENDING_REVIEW'?
   'BLOCKED_PENDING_NAME_REVIEW':
  status==='DECLINED'?
   'BLOCKED_NAME_DECLINED':
  'BLOCKED_NAME_UNAVAILABLE';
}
async function run({env=process.env,transport=https,log=console}={}){
 require('dotenv').config();
 const status=await readMetaNameStatus({
  token:env.WABA_TOKEN,phoneId:env.WABA_PHONE_ID,transport
 });
 const gate=classify(status);
 log.log('F06_META_METHOD=GET_ONLY');
 log.log('F06_META_NAME_STATUS='+status);
 log.log('F06_META_GATE='+gate);
 log.log('F06_META_MESSAGES_SENT=0');
 log.log('F06_OPENPAY_CHARGES=0');
 log.log('F06_META_DELIVERY=NOT_CERTIFIED');
 return {status,gate};
}
if(require.main===module){
 run().then(result=>{
  if(result.gate!=='NAME_READY_DELIVERY_UNVERIFIED')process.exitCode=2;
 }).catch(_error=>{
  console.error('F06_META_METHOD=GET_ONLY');
  console.error('F06_META_GATE=STATUS_UNAVAILABLE_CHECK_WHATSAPP_MANAGER');
  console.error('F06_META_MESSAGES_SENT=0');
  console.error('F06_OPENPAY_CHARGES=0');
  process.exitCode=2;
 });
}
module.exports={readMetaNameStatus,classify,run};
