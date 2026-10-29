'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {createPgInvitations}=require('../src/wabaPgInvitations');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
pgTest('R36 invitation survives pool restart and claim stays single-use',async()=>{
 let first=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 const issued=await createPgInvitations({pool:first}).issue({requesterId:'521555000036',amountCents:3600});
 assert.equal(issued.state,'ISSUED');
 await first.end();
 const second=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:2});
 try{
  const svc=createPgInvitations({pool:second});
  const claimed=await svc.claim({token:issued.token});
  assert.equal(claimed.state,'CLAIMED');
  assert.equal(claimed.amountCents,3600);
  assert.equal((await svc.claim({token:issued.token})).state,'NOT_ELIGIBLE_HOLD');
  const d=crypto.createHash('sha256').update(issued.token).digest('hex');
  const persisted=await second.query('SELECT request_id,consumed_at FROM waba_channel.invitation_claims WHERE token_sha256=$1',[d]);
  assert.equal(persisted.rows[0].request_id,claimed.requestId);
  assert.ok(persisted.rows[0].consumed_at);
 }finally{await second.end()}
});
