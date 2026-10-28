'use strict';
// F06 offline evidence model ONLY. Not wired into the live webhook or payment
// code. Never call Meta, Openpay, WhatsApp or mutate existing storage.
const crypto=require('node:crypto');
const STATES=new Set(['sent','delivered','read','failed']);
const RANK={ACCEPTED_BY_META:0,sent:1,delivered:2,read:3};
const ROLES=new Set(['PAYER','COLLECTOR']);
const ID_RE=/^wamid\.[A-Za-z0-9._-]{4,255}$/;
const PHONE_RE=/^\d{8,20}$/;

function normalizeRecipient(value){
 if(typeof value!=='string'||!PHONE_RE.test(value))return null;
 // Consistent with src/waba.js legacy normalizer; in particular 521 vs 52.
 return value.startsWith('521')&&value.length===13?'52'+value.slice(3):value;
}
function verifySignature(raw,header,secret){
 if(!Buffer.isBuffer(raw)||typeof secret!=='string'||secret.length<16||
    typeof header!=='string'||!/^sha256=[0-9a-fA-F]{64}$/.test(header))return false;
 const received=Buffer.from(header.slice(7),'hex');
 const expected=crypto.createHmac('sha256',secret).update(raw).digest();
 return received.length===expected.length&&crypto.timingSafeEqual(received,expected);
}
function createDeliveryEvidence({appSecret,phoneId,testToOverride='',maxRecords=100}={}){
 if(typeof appSecret!=='string'||appSecret.length<16||
    typeof phoneId!=='string'||!/^\d{8,24}$/.test(phoneId)||
    !Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>10000)
  throw Error('F06_EVIDENCE_CONFIGURATION');
 const records=new Map();
 function recordAcceptance({role,recipient,metaResponse}={}){
  // Must be called only by a trusted caller after an actual Meta 2xx response.
  if(testToOverride)throw Error('F06_TEST_TO_OVERRIDE_ACTIVE');
  const normalized=normalizeRecipient(recipient);
  const id=metaResponse?.messages?.[0]?.id;
  if(!ROLES.has(role)||!normalized||!ID_RE.test(id||''))
   throw Error('F06_ACCEPTANCE_INVALID');
  const existing=records.get(id);
  if(existing){
   if(existing.role!==role||existing.recipient!==normalized)
    throw Error('F06_ACCEPTANCE_CONFLICT');
   return {state:existing.state,duplicate:true};
  }
  if(records.size>=maxRecords)throw Error('F06_EVIDENCE_CAPACITY');
  records.set(id,{role,recipient:normalized,state:'ACCEPTED_BY_META',
   errorCode:null,latestTimestamp:0});
  return {state:'ACCEPTED_BY_META',duplicate:false};
 }
 function ingestSignedStatus({rawBody,signature}={}){
  const bytes=Buffer.isBuffer(rawBody)?rawBody:
   typeof rawBody==='string'?Buffer.from(rawBody,'utf8'):null;
  if(!bytes||bytes.length===0||bytes.length>65536)
   throw Error('F06_WEBHOOK_INVALID_BODY');
  if(!verifySignature(bytes,signature,appSecret))
   throw Error('F06_WEBHOOK_UNVERIFIED');
  let envelope;
  try{envelope=JSON.parse(bytes.toString('utf8'));}
  catch(_e){throw Error('F06_WEBHOOK_INVALID_JSON');}
  if(envelope?.object!=='whatsapp_business_account'||!Array.isArray(envelope.entry))
   throw Error('F06_WEBHOOK_INVALID_ENVELOPE');
  const counts={updated:0,duplicate:0,ignored:0,conflict:0};
  for(const entry of envelope.entry.slice(0,25)){
   for(const change of (Array.isArray(entry?.changes)?entry.changes:[]).slice(0,25)){
    if(change?.field!=='messages'||change?.value?.metadata?.phone_number_id!==phoneId){
     counts.ignored++;continue;
    }
    for(const event of (Array.isArray(change.value.statuses)?change.value.statuses:[]).slice(0,100)){
     const r=records.get(event?.id);
     if(!r||!STATES.has(event?.status)){
      counts.ignored++;continue;
     }
     const to=normalizeRecipient(event.recipient_id);
     const timestamp=Number(event.timestamp);
     if(!to||to!==r.recipient||!Number.isSafeInteger(timestamp)||
        timestamp<1||timestamp>99999999999){
      counts.ignored++;continue;
     }
     const incoming=event.status,current=r.state;
     if(current===incoming){counts.duplicate++;continue;}
     if(current==='failed'||(incoming==='failed'&&
        (current==='delivered'||current==='read'))){
      counts.conflict++;continue;
     }
     if(incoming!=='failed'&&RANK[incoming]<=RANK[current]){
      counts.ignored++;continue;
     }
     r.state=incoming;
     r.latestTimestamp=Math.max(r.latestTimestamp,timestamp);
     // Store numeric Meta error code only. Never log error title, message or raw payload.
     r.errorCode=incoming==='failed'&&Number.isSafeInteger(event.errors?.[0]?.code)?
      event.errors[0].code:null;
     counts.updated++;
    }
   }
  }
  return {...counts};
 }
 function summary(){
  const states={ACCEPTED_BY_META:0,sent:0,delivered:0,read:0,failed:0};
  const byRole={COLLECTOR:null,PAYER:null};
  const destinations=new Set();
  for(const r of records.values()){
   states[r.state]++;
   if((r.state==='delivered'||r.state==='read')&&
       !destinations.has(r.recipient)&&byRole[r.role]===null){
    byRole[r.role]='DELIVERED_OR_READ';
    destinations.add(r.recipient);
   }
  }
  return {
   tracked:records.size,states,roles:{...byRole},
   evidenceBilateralDelivered:destinations.size>=2&&
     byRole.PAYER==='DELIVERED_OR_READ'&&byRole.COLLECTOR==='DELIVERED_OR_READ',
   isLiveIntegrated:false
  };
 }
 function exportSnapshot(){
  return {version:1,records:[...records.entries()].map(([id,r])=>({
   id,role:r.role,recipient:r.recipient,state:r.state,
   errorCode:r.errorCode,latestTimestamp:r.latestTimestamp
  }))};
 }
 function restoreSnapshot(snapshot){
  if(testToOverride)throw Error('F06_TEST_TO_OVERRIDE_ACTIVE');
  if(!snapshot||snapshot.version!==1||!Array.isArray(snapshot.records)||
   snapshot.records.length>maxRecords)throw Error('F06_SNAPSHOT_INVALID');
  const next=new Map();
  for(const r of snapshot.records){
   if(!r||!ID_RE.test(r.id||'')||!ROLES.has(r.role)||
      normalizeRecipient(r.recipient)!==r.recipient||
      !['ACCEPTED_BY_META',...STATES].includes(r.state)||
      !Number.isSafeInteger(r.latestTimestamp)||r.latestTimestamp<0||
      (r.errorCode!==null&&(!Number.isSafeInteger(r.errorCode)||r.errorCode<0))||
      next.has(r.id))throw Error('F06_SNAPSHOT_INVALID');
   if((r.state==='ACCEPTED_BY_META'&&r.latestTimestamp!==0)||
      (r.state!=='ACCEPTED_BY_META'&&r.latestTimestamp===0)||
      (r.state!=='failed'&&r.errorCode!==null))
    throw Error('F06_SNAPSHOT_INVALID');
   next.set(r.id,{
    role:r.role,recipient:r.recipient,state:r.state,
    errorCode:r.errorCode,latestTimestamp:r.latestTimestamp
   });
  }
  records.clear();
  for(const [id,r] of next)records.set(id,r);
 }
 return Object.freeze({recordAcceptance,ingestSignedStatus,summary,
  exportSnapshot,restoreSnapshot});
}
module.exports={createDeliveryEvidence,normalizeRecipient,verifySignature};
