'use strict';
// Single-shot HTTPS transport to BusinessOS internal authorization endpoint.
// Must be wired deliberately with a delegated Security Engine credential.
// NEVER enabled via startup env flags or any public URL.
const https=require('node:https');
const {ENDPOINT}=require('./businessosAuthorizationAdapter');
function createBusinessosHttpsTransport({baseUrl,requestImpl=https.request,timeoutMs=5000}={}){
 let url;
 try{url=new URL(baseUrl);}catch(_e){throw Error('BUSINESSOS_ENDPOINT_INVALID');}
 if(url.protocol!=='https:'||!url.hostname||url.username||url.password||
    url.pathname!=='/'||url.search||url.hash||!Number.isInteger(timeoutMs)||
    timeoutMs<100||timeoutMs>30000)
  throw Error('BUSINESSOS_ENDPOINT_INVALID');
 const dest=new URL(ENDPOINT,url);
 return async function send({method,path,body,delegatedBearer}={}){
  if(method!=='POST'||path!==ENDPOINT||!body||
      typeof delegatedBearer!=='string'||!/^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(delegatedBearer))
    throw Error('BUSINESSOS_TRANSPORT_INPUT_INVALID');
  const wire=Buffer.from(JSON.stringify(body),'utf8');
  if(wire.length>16384)throw Error('BUSINESSOS_PAYLOAD_TOO_LARGE');
  return await new Promise((resolve,reject)=>{
   let finished=false;
   const succeed=value=>{if(!finished){finished=true;resolve(value);}};
   const fail=()=>{if(!finished){finished=true;reject(Error('BUSINESSOS_REQUEST_INDETERMINATE'));}};
   let req;
   try{
    req=requestImpl({
     protocol:'https:',hostname:dest.hostname,port:dest.port||443,
     path:dest.pathname,method:'POST',
     headers:{
      'Authorization':'Bearer '+delegatedBearer,
      'Content-Type':'application/json',
      'Accept':'application/json',
      'Content-Length':wire.length
     },
     timeout:timeoutMs,
     maxRedirects:0
    },res=>{
      let size=0,chunks=[];
      res.on('data',chunk=>{
       size+=chunk.length;
       if(size>32768){req.destroy();fail();}
       else chunks.push(chunk);
      });
      res.on('error',fail);
      res.on('aborted',fail);
      res.on('end',()=>{
       if(finished)return;
       let parsed=null;
       try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
       catch(_error){fail();return;}
       succeed({httpStatus:res.statusCode,body:parsed});
      });
     });
     req.on('error',fail);
     req.on('timeout',()=>{req.destroy();fail();});
     req.end(wire);
   }catch(_error){fail();}
  });
 };
}
module.exports={createBusinessosHttpsTransport};
