'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const DEFAULT_FILE=path.join(process.cwd(),'data','waba-vault.json');
function goodId(s){return typeof s==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(s);}
function fourDigits(s){return typeof s==='string'&&/^[0-9]{4}$/.test(s);}
function digestPin(pin,salt,pepper){
 const keyed=crypto.createHmac('sha256',pepper).update('kashbit-waba-pin-v1:').update(pin).digest();
 return crypto.scryptSync(keyed,Buffer.from(salt,'hex'),64).toString('hex');
}
function createVault({filePath=DEFAULT_FILE,pepper=process.env.KASHBIT_PIN_PEPPER||'',
 provider=null,now=()=>Date.now()}={}){
 let entries={};
 if(filePath&&fs.existsSync(filePath)){
  const parsed=JSON.parse(fs.readFileSync(filePath,'utf8'));
  if(!parsed||parsed.version!==1||!parsed.accounts||typeof parsed.accounts!=='object'||Array.isArray(parsed.accounts))
   throw Error('Invalid vault store');
  entries=parsed.accounts;
 }
 const busy=new Set();
 function owner(id){
  if(!goodId(id))throw Error('Invalid account');
  return entries[id]||{customerId:null,cards:[],pin:null};
 }
 function mutate(id,callback){
  const current=entries[id]||{customerId:null,cards:[],pin:null};
  const updated=structuredClone(current);
  const result=callback(updated);
  const previous=entries[id];
  entries[id]=updated;
  try{persist();}
  catch(error){if(previous)entries[id]=previous;else delete entries[id];throw error;}
  return result;
 }
 function persist(){
  if(!filePath)return;
  fs.mkdirSync(path.dirname(filePath),{mode:0o700,recursive:true});
  const tmp=filePath+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:1,accounts:entries}),{mode:0o600});
  fs.renameSync(tmp,filePath);
 }
 function profile(accountId){
  const saved=owner(accountId);
  return {
   pinConfigured:!!saved.pin,
   cards:saved.cards.map(c=>({id:c.id,brand:c.brand,last4:c.last4})),
   enrollmentEnabled:!!provider,
   pinEnabled:typeof pepper==='string'&&pepper.length>=32
  };
 }
 function ownedCard(accountId,cardId){
  if(typeof cardId!=='string')return null;
  const record=owner(accountId);
  const card=record.cards.find(c=>c.id===cardId&&c.customerId===record.customerId);
  return card?{...card}:null;
 }
 function setPin(accountId,pin,password,verifyPassword,{reset=false}={}){
  if(typeof pepper!=='string'||pepper.length<32)throw Error('NIP no configurado en este entorno');
  if(!fourDigits(pin))throw Error('NIP: deben ser cuatro dígitos');
  if(typeof verifyPassword!=='function'||!verifyPassword(accountId,password))
   throw Error('Contraseña de cuenta incorrecta');
  if(!!owner(accountId).pin&&!reset)throw Error('El NIP ya existe; usa cambiar NIP');
  if(!owner(accountId).pin&&reset)throw Error('Primero registra tu NIP');
  const salt=crypto.randomBytes(16).toString('hex');
  mutate(accountId,record=>{record.pin={salt,hash:digestPin(pin,salt,pepper),attempts:0,lockedUntil:0};});
  return {configured:true};
 }
 function verifyPin(accountId,pin){
  const record=owner(accountId).pin;
  if(!record||!fourDigits(pin)||typeof pepper!=='string'||pepper.length<32)return false;
  if(record.lockedUntil>now())return false;
  if(record.attempts>=5)return false;
  const attempt=Buffer.from(digestPin(pin,record.salt,pepper),'hex');
  const stored=Buffer.from(record.hash,'hex');
  const ok=stored.length===attempt.length&&crypto.timingSafeEqual(attempt,stored);
  mutate(accountId,r=>{
   r.pin.attempts=ok?0:r.pin.attempts+1;
   r.pin.lockedUntil=(!ok&&r.pin.attempts>=5)?now()+15*60*1000:0;
  });
  return ok;
 }
 async function enroll(accountId,params){
  if(!provider)throw Error('Enrolamiento Sandbox no habilitado');
  if(busy.has(accountId))throw Error('Enrolamiento en curso; no repetir');
  if(!goodId(accountId))throw Error('Invalid account');
  const {tokenId,deviceSessionId,firstName,lastName,email,consent}=params||{};
  function invalid(stage,message){
   const error=new Error(message);
   error.enrollmentStage=stage;
   throw error;
  }
  if(consent!==true)invalid('VALIDATE_CONSENT','Se requiere consentimiento para guardar la tarjeta');
  if(!goodId(tokenId))invalid('VALIDATE_TOKEN','Token inválido');
  if(typeof deviceSessionId!=='string'||!/^[A-Za-z0-9_-]{8,255}$/.test(deviceSessionId))
   invalid('VALIDATE_DEVICE','Sesión antifraude inválida');
  if(typeof firstName!=='string'||!firstName.trim()||firstName.length>80
    ||typeof lastName!=='string'||!lastName.trim()||lastName.length>80)
   invalid('VALIDATE_NAME','Datos de titular inválidos');
  if(typeof email!=='string'||email.length>254||!email.includes('@'))invalid('VALIDATE_EMAIL','Correo inválido');
  if(owner(accountId).cards.length>=10)invalid('VALIDATE_LIMIT','Límite de tarjetas alcanzado');
  busy.add(accountId);
  let stage='CREATE_CUSTOMER';
  try{
   let customerId=owner(accountId).customerId;
   if(!customerId){
    const customer=await provider.createCustomer({firstName:firstName.trim(),lastName:lastName.trim(),email});
    if(!goodId(customer?.id))throw Error('Referencia de cliente inválida');
    customerId=customer.id;
    stage='STORE_CUSTOMER';
    mutate(accountId,r=>{r.customerId=customerId;});
   }
   stage='CREATE_CARD';
   const card=await provider.addCard(customerId,tokenId,deviceSessionId);
   if(!goodId(card?.id))throw Error('Referencia de tarjeta inválida');
   stage='GET_CARD';
   const checked=await provider.getCard(customerId,card.id);
   stage='VERIFY_CARD';
   if(checked?.id!==card.id||checked.customer_id!==customerId||
    checked.allows_charges===false)throw Error('Tarjeta no confirmada por proveedor');
   const masked=String(checked.card_number||'');
   const last4=masked.slice(-4);
   if(!/^[0-9]{4}$/.test(last4))throw Error('Últimos cuatro dígitos no verificados');
   const brand=String(checked.brand||'').slice(0,30);
   if(!/^[A-Za-z0-9 -]{1,30}$/.test(brand))throw Error('Marca de tarjeta inválida');
   stage='STORE_CARD';
   mutate(accountId,r=>{
    if(r.cards.some(c=>c.id===card.id))throw Error('Tarjeta ya registrada');
    r.cards.push({id:card.id,brand,last4,customerId,merchantId:provider.merchantId,createdAt:now()});
   });
   return {id:card.id,brand,last4};
  }catch(error){
   if(error&&typeof error==='object')error.enrollmentStage=stage;
   throw error;
  }finally{busy.delete(accountId);}
 }
 return {profile,ownedCard,setPin,verifyPin,enroll,provider};
}
module.exports={createVault};
