'use strict';
// R9: opt-in Security Engine PDP HTTPS transport. No credential storage.
// Payment Engine owns delegated-token validation on /service/validate.
// Do NOT mount in the ordinary WABA runtime, nor enable via an env toggle.
const https=require('node:https');
const {createBusinessosDelegationGate,buildDelegationIntent}=
 require('./businessosSecurityDelegationGate');
const AUTHORIZE='/internal/security/v1/service/authorize';
const TOKEN=/^[A-Za-z0-9._~+\/=-]{16,4096}$/;
const MAX_RESPONSE=32768;
function canonicalEndpoint(baseUrl){
 let base;
 try{base=new URL(baseUrl);}catch(_e){throw Error('R9_ENDPOINT_INVALID');}
 if(base.protocol!=='https:'||!base.hostname||base.username||base.password||
    base.pathname!=='/'||base.search||base.hash||
    base.hostname.includes('%')||base.hostname.includes('\\'))
  throw Error('R9_ENDPOINT_INVALID');
 return Object.freeze({hostname:base.hostname,port:base.port||443,
  servername:base.hostname,path:AUTHORIZE});
}
function createSecurityEngineS2SClient({
 baseUrl,credentialProvider,requestImpl=https.request,
 enabled=false,timeoutMs=5000
}={}){
 const target=canonicalEndpoint(baseUrl);
 if(typeof credentialProvider!=='function'||typeof requestImpl!=='function'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)
  throw Error('R9_CONFIG_INVALID');
 // This transport cannot accept caller-specified URLs, paths or credentials.
 // It is always a single POST. Node's HTTPS client does not follow redirects.
 function postIntent(intent,credential){
  if(!TOKEN.test(credential||'')||
     !intent||!Object.isFrozen(intent)||
     intent.audience!=='Payment'||intent.permission!=='payment.authorize'||
     intent.scopeType!=='TENANT'||intent.scopeValue!==null||
     intent.targetType!==null||intent.targetId!==null||
     intent.targetTenantId!==intent.scopeTenantId)
   return Promise.reject(Error('R9_TRUST_BOUNDARY'));
  const payload=Buffer.from(JSON.stringify(intent),'utf8');
  if(payload.length>4096)return Promise.reject(Error('R9_PAYLOAD_INVALID'));
  return new Promise((resolve,reject)=>{
   let complete=false,request;
   const ok=value=>{if(!complete){complete=true;resolve(value);}};
   const bad=()=>{if(!complete){complete=true;reject(Error('R9_PDP_UNAVAILABLE'));}};
   try{
    request=requestImpl({
     protocol:'https:',hostname:target.hostname,port:target.port,
     servername:target.servername,path:target.path,method:'POST',
     rejectUnauthorized:true,
     headers:{
      Authorization:'Bearer '+credential,
      'Content-Type':'application/json',
      Accept:'application/json',
      'Content-Length':payload.length,
      'Cache-Control':'no-store'
     },
     timeout:timeoutMs,
     maxRedirects:0
    },response=>{
     let size=0;const chunks=[];
     response.on('data',chunk=>{
      size+=chunk.length;
      if(size>MAX_RESPONSE){
       if(request&&typeof request.destroy==='function')request.destroy();
       bad();return;
      }
      chunks.push(chunk);
     });
     response.on('error',bad);
     response.on('aborted',bad);
     response.on('end',()=>{
      if(complete)return;
      const status=response.statusCode;
      // Security Engine only has documented authoritative outcomes:
      // 200 ALLOW, 401/403 DENY, 503 UNAVAILABLE. Others fail closed.
      if(![200,401,403,503].includes(status)){
       ok({httpStatus:503,body:null});return;
      }
      if(status!==200){ok({httpStatus:status,body:null});return;}
      const contentType=String(response.headers?.['content-type']||'').toLowerCase();
      if(!/^application\/json(?:\s*;|$)/.test(contentType)){
       bad();return;
      }
      let parsed;
      try{
       parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }catch(_e){bad();return;}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){bad();return;}
      ok({httpStatus:status,body:parsed});
     });
    });
    request.on('error',bad);
    request.on('timeout',()=>{
     if(typeof request.destroy==='function')request.destroy();
     bad();
    });
    request.end(payload);
   }catch(_e){bad();}
  });
 }
 const gate=createBusinessosDelegationGate({
  enabled,delegateTransport:async intent=>{
   // ServiceCredential comes from a trusted, injected provider. It is never
   // derived from browser, WhatsApp messages or tenant request fields.
   const credential=await credentialProvider();
   if(typeof credential!=='string'||!TOKEN.test(credential))
    throw Error('R9_CREDENTIAL_INVALID');
   return postIntent(intent,credential);
  }
 });
 async function delegate({trustedTenantId}={}){
  // Disabled means neither the credential provider nor transport is touched.
  return gate.delegate({trustedTenantId});
 }
 return Object.freeze({delegate,isEnabled:enabled===true,
  isFinancialDispatcher:false});
}
module.exports={AUTHORIZE,canonicalEndpoint,createSecurityEngineS2SClient};
