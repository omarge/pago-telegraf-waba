'use strict';
// Opt-in bootstrap: do not ACK Meta until signed envelope is committed.
// Missing credentials/schema fail BEFORE opening the public webhook listener.
// No credentials are logged and migrations are NEVER executed on startup.
const {createPgSignedInbox}=require('./businessosPgSignedInbox');
function durableMode(env={}){
 const flag=env.WABA_BUSINESSOS_DURABLE_WEBHOOK;
 if(flag==null||flag===''||flag==='0')return false;
 if(flag==='1')return true;
 throw Error('WABA_DURABLE_INGRESS_MODE_INVALID');
}
async function createDurableIngress({env=process.env,PoolClass}={}){
 if(!durableMode(env))return null;
 // Strict BusinessOS ingress cannot coexist with the legacy direct PSP charge.
 if(env.WABA_SAVED_CARD_PAY_SANDBOX==='1')
  throw Error('WABA_DURABLE_INGRESS_DIRECT_PSP_CONFLICT');
 const url=env.WABA_CHANNEL_PG_URL,secret=env.WABA_APP_SECRET,key=env.WABA_INBOX_AES256_KEY_HEX;
 if(typeof url!=='string'||!/^postgres(?:ql)?:\/\//.test(url)||
    typeof secret!=='string'||secret.length<16||
    typeof key!=='string'||!/^[0-9a-fA-F]{64}$/.test(key))
  throw Error('WABA_DURABLE_INGRESS_CONFIG_INVALID');
 // Lazy import: the historical pilot does not connect to PostgreSQL by default.
 const Pool=PoolClass||require('pg').Pool;
 const pool=new Pool({connectionString:url,max:5,connectionTimeoutMillis:3000,
  statement_timeout:5000,query_timeout:5000});
 try{
  const check=await pool.query("SELECT "+
   "to_regclass('waba_channel.signed_envelopes') AS envelopes, "+
   "to_regclass('waba_channel.inbox') AS inbox");
  if(check.rowCount!==1||!check.rows[0].envelopes||!check.rows[0].inbox)
   throw Error('WABA_DURABLE_INGRESS_SCHEMA_NOT_READY');
  const inbox=createPgSignedInbox({pool,appSecret:secret,encryptionKey:Buffer.from(key,'hex')});
  return Object.freeze({inbox,close:()=>pool.end(),isDurableIngress:true});
 }catch(_e){
  try{await pool.end();}catch(_ignored){}
  throw Error('WABA_DURABLE_INGRESS_NOT_READY');
 }
}
module.exports={durableMode,createDurableIngress};
