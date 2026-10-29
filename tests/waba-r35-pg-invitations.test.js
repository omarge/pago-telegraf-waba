'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Pool}=require('pg');
const {createPgInvitations}=require('../src/wabaPgInvitations');
const pgTest=process.env.R4_POSTGRES_TEST_URL?test:test.skip;
pgTest('R35 two independent connections produce exactly one financial request',async()=>{
 const pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:8});
 try{
  await pool.query(fs.readFileSync(path.join(__dirname,'../db/waba-r4-channel.sql'),'utf8'));
  await pool.query(fs.readFileSync(path.join(__dirname,'../db/waba-r35-invitations.sql'),'utf8'));
  const invitations=createPgInvitations({pool}),issued=await invitations.issue({requesterId:'521555000000',amountCents:1000});
  assert.equal(issued.state,'ISSUED');
  const outcomes=await Promise.all(Array.from({length:16},()=>invitations.claim({token:issued.token})));
  assert.equal(outcomes.filter(x=>x.state==='CLAIMED').length,1);
  assert.equal(outcomes.filter(x=>x.state==='NOT_ELIGIBLE_HOLD').length,15);
  const count=await pool.query('SELECT count(*)::int AS n FROM waba_channel.requests WHERE requester_wa_id=$1',['521555000000']);
  assert.equal(count.rows[0].n,1);
  assert.equal((await invitations.claim({token:issued.token})).state,'NOT_ELIGIBLE_HOLD');
 }finally{await pool.end();}
});
pgTest('R35 missing or expired invitation never creates a request',async()=>{
 const pool=new Pool({connectionString:process.env.R4_POSTGRES_TEST_URL,max:3});
 try{
  const invites=createPgInvitations({pool});
  assert.equal((await invites.claim({token:'A'.repeat(32)})).state,'NOT_ELIGIBLE_HOLD');
  const issued=await invites.issue({requesterId:'521555000001',amountCents:250});
  assert.equal(issued.state,'ISSUED');
  await pool.query('UPDATE waba_channel.invitation_claims SET created_at=clock_timestamp()-interval \'2 days\', expires_at=clock_timestamp()-interval \'1 day\' WHERE token_sha256=$1',
   [require('node:crypto').createHash('sha256').update(issued.token).digest('hex')]);
  assert.equal((await invites.claim({token:issued.token})).state,'NOT_ELIGIBLE_HOLD');
 }finally{await pool.end();}
});
