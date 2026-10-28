'use strict';
const https=require('node:https');
function validId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{8,60}$/.test(value);}
function createSandboxProvider({merchantId=process.env.OPENPAY_MERCHANT_ID,
 privateKey=process.env.OPENPAY_PRIVATE_KEY,publicKey=process.env.OPENPAY_PUBLIC_KEY,
 enabled=process.env.WABA_CARD_ENROLL_SANDBOX==='1',transport=https}={}){
 if(!enabled)return null; // Explicit opt-in, independent from the already-working checkout.
 if(!validId(merchantId)||!privateKey||!publicKey)throw new Error('Openpay Sandbox card provider not configured');
 const root='/v1/'+merchantId;
 function call(method,resource,payload){
  const data=payload?JSON.stringify(payload):'';
  return new Promise((resolve,reject)=>{
   const req=transport.request({
    hostname:'sandbox-api.openpay.mx',port:443,method,path:root+resource,
    timeout:10000,headers:{
     Authorization:'Basic '+Buffer.from(privateKey+':').toString('base64'),
     Accept:'application/json','Content-Type':'application/json',
     ...(data?{'Content-Length':Buffer.byteLength(data)}:{})
    }
   },res=>{
    let body='',length=0;
    res.on('data',part=>{
     length+=part.length;
     if(length>65536){req.destroy(new Error('Provider response too large'));return;}
     body+=part;
    });
    res.on('end',()=>{
     if(res.statusCode<200||res.statusCode>=300)return reject(new Error('Openpay Sandbox HTTP '+res.statusCode));
     try{const parsed=JSON.parse(body);resolve(parsed);}
     catch(_e){reject(new Error('Invalid Openpay Sandbox response'));}
    });
   });
   req.on('timeout',()=>req.destroy(new Error('Openpay Sandbox timeout')));
   req.on('error',reject);
   if(data)req.write(data);
   req.end();
  });
 }
 return Object.freeze({
  merchantId,publicKey,
  createCustomer:async profile=>call('POST','/customers',{
   name:profile.firstName,last_name:profile.lastName,email:profile.email,requires_account:false
  }),
  addCard:async(customerId,tokenId,deviceSessionId)=>{
   if(!validId(customerId))throw Error('Invalid customer reference');
   return call('POST','/customers/'+customerId+'/cards',{
    token_id:tokenId,device_session_id:deviceSessionId
   });
  },
  getCard:async(customerId,cardId)=>{
   if(!validId(customerId)||!validId(cardId))throw Error('Invalid card reference');
   return call('GET','/customers/'+customerId+'/cards/'+cardId);
  }
 });
}
module.exports={createSandboxProvider};
