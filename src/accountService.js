'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const SESSION_MS=8*60*60*1000;
const LINK_MS=10*60*1000;
const DEFAULT_FILE=path.join(process.cwd(),'data','waba-accounts.json');
function sha(value){return crypto.createHash('sha256').update(value).digest('hex');}
function random(){return crypto.randomBytes(32).toString('base64url');}
function normalizeEmail(email){return String(email||'').trim().toLowerCase();}
function createAccountService({filePath=DEFAULT_FILE,now=()=>Date.now()}={}){
 let accounts=[];
 if(filePath && fs.existsSync(filePath)){
  const parsed=JSON.parse(fs.readFileSync(filePath,'utf8'));
  if(!Array.isArray(parsed.accounts))throw new Error('Invalid account store');
  accounts=parsed.accounts;
 }
 const sessions=new Map();
 const challenges=new Map();
 function save(){
  if(!filePath)return;
  fs.mkdirSync(path.dirname(filePath),{recursive:true,mode:0o700});
  const tmp=filePath+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:1,accounts}),{mode:0o600,flag:'w'});
  fs.renameSync(tmp,filePath);
 }
 function sessionFor(accountId){
  const token=random();
  const record={accountId,expiresAt:now()+SESSION_MS,csrf:random()};
  sessions.set(sha(token),record);
  return {token,csrf:record.csrf};
 }
 function getSession(token){
  if(typeof token!=='string'||token.length<30)return null;
  const key=sha(token),session=sessions.get(key);
  if(!session)return null;
  if(session.expiresAt<=now()){sessions.delete(key);return null;}
  const account=accounts.find(a=>a.id===session.accountId);
  if(!account){sessions.delete(key);return null;}
  return {accountId:account.id,email:account.email,whatsappLinked:!!account.waId,csrf:session.csrf};
 }
 function register(email,password){
  email=normalizeEmail(email);
  if(email.length>254||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(email))throw new Error('Correo inválido');
  if(typeof password!=='string'||password.length<12||password.length>256)throw new Error('La contraseña debe tener entre 12 y 256 caracteres');
  if(accounts.some(a=>a.email===email))throw new Error('Cuenta existente');
  const salt=crypto.randomBytes(16).toString('hex');
  const digest=crypto.scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');
  const account={id:crypto.randomUUID(),email,salt,digest,waId:null,createdAt:now()};
  accounts.push(account);
  try{save();}catch(error){accounts.pop();throw error;}
  return sessionFor(account.id);
 }
 function login(email,password){
  email=normalizeEmail(email);
  const account=accounts.find(a=>a.email===email);
  if(!account||typeof password!=='string'||password.length>256)return null;
  const actual=crypto.scryptSync(password,Buffer.from(account.salt,'hex'),64);
  const expected=Buffer.from(account.digest,'hex');
  if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))return null;
  return sessionFor(account.id);
 }
 function logout(token){if(typeof token==='string')sessions.delete(sha(token));}
 function validCsrf(token,csrf){
  const session=getSession(token);
  if(!session||typeof csrf!=='string')return false;
  const a=Buffer.from(session.csrf),b=Buffer.from(csrf);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
 }
 function beginLink(token,csrf){
  if(!validCsrf(token,csrf))return null;
  const session=getSession(token);
  const account=accounts.find(a=>a.id===session.accountId);
  if(account.waId)return {alreadyLinked:true};
  for(const [key,value] of challenges){
   if(value.accountId===account.id)challenges.delete(key);
  }
  const code=crypto.randomBytes(8).toString('hex').toUpperCase();
  challenges.set(sha(code),{accountId:account.id,expiresAt:now()+LINK_MS});
  return {code,expiresAt:now()+LINK_MS};
 }
 function bindFromWhatsApp(waId,code){
  if(!/^\d{8,20}$/.test(String(waId||''))||!/^[0-9A-F]{16}$/.test(String(code||'')))return false;
  const key=sha(code),challenge=challenges.get(key);
  if(!challenge)return false;
  challenges.delete(key);
  if(challenge.expiresAt<=now())return false;
  const account=accounts.find(a=>a.id===challenge.accountId);
  if(!account||account.waId)return false;
  if(accounts.some(a=>a.waId===waId))return false;
  account.waId=waId;
  try{save();}catch(error){account.waId=null;throw error;}
  return true;
 }
 function getLinkedAccount(waId){
  const account=accounts.find(a=>a.waId===waId);
  return account?{id:account.id}:null;
 }
 return {register,login,logout,getSession,validCsrf,beginLink,bindFromWhatsApp,getLinkedAccount};
}
const accountService=createAccountService();
module.exports={createAccountService,accountService,SESSION_MS,LINK_MS};
