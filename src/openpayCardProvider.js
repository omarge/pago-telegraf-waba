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
     if(res.statusCode<200||res.statusCode>=300){
      const error=new Error('Openpay Sandbox rejected request');
      if(Number.isInteger(res.statusCode)&&res.statusCode>=400&&res.statusCode<=599)
       error.openpayHttpStatus=res.statusCode;
      try{
       const parsed=JSON.parse(body),code=String(parsed?.error_code??'');
       if(/^[0-9]{3,6}$/.test(code))error.openpayCode=code;
      }catch(_ignored){} // No provider description or sensitive payload may escape.
      return reject(error);
     }
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
  },
  chargeSavedCard:async({customerId,cardId,amountCents,requestId,deviceSessionId})=>{
   if(process.env.WABA_SAVED_CARD_PAY_SANDBOX!=='1')throw Error('Sandbox saved-card charges disabled');
   if(!validId(customerId)||!validId(cardId)||
      typeof requestId!=='string'||!/^KPR-[A-F0-9]{32}$/.test(requestId)||
      !Number.isSafeInteger(amountCents)||amountCents<=0||
      typeof deviceSessionId!=='string'||!/^[A-Za-z0-9_-]{8,255}$/.test(deviceSessionId))
     throw Error('Invalid saved-card charge');
   return call('POST','/customers/'+customerId+'/charges',{
    method:'card',source_id:cardId,amount:amountCents/100,currency:'MXN',
    order_id:requestId,description:'KashBitPay WABA saved card Sandbox',
    device_session_id:deviceSessionId
   });
  },
  getCharge:async(customerId,chargeId)=>{
   if(!validId(customerId)||!validId(chargeId))throw Error('Invalid charge reference');
   return call('GET','/customers/'+customerId+'/charges/'+chargeId);
  }
 });
}
module.exports={createSandboxProvider};
