'use strict';
// PostgreSQL CREATE TABLE IF NOT EXISTS is not DDL-concurrency-safe across
// independent Node test workers. Serialize ONLY test schema bootstrapping
// with a session advisory lock on the same CI database.
const fs=require('node:fs'),path=require('node:path');
async function applyTestChannelMigrations(pool,files){
 if(!pool||typeof pool.connect!=='function'||!Array.isArray(files)||!files.length)
  throw Error('R6_TEST_MIGRATION_CONFIG');
 const c=await pool.connect();
 let held=false;
 try{
  await c.query('SELECT pg_advisory_lock(20261028, 6)');
  held=true;
  for(const file of files){
   if(!/^waba-r(?:[456789]|10|11)-channel\.sql$|^waba-r12-(?:canonical-channel|kafka-ingress)\.sql$/.test(file))
    throw Error('R6_TEST_MIGRATION_FILE');
   await c.query(fs.readFileSync(path.resolve(__dirname,'../db',file),'utf8'));
  }
 }finally{
  if(held)try{await c.query('SELECT pg_advisory_unlock(20261028, 6)');}finally{c.release();}
  else c.release();
 }
}
module.exports={applyTestChannelMigrations};
