'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const nav=require('../src/navigation');
const {createWebhook}=require('../src/webhook');
const {PAGES,renderPage}=require('../src/microapps');
function fixture(){
 const calls=[],conv=new Map();
 const messenger={
  async sendMessage(...args){calls.push(['message',...args]);return {messages:[{id:'fake'}]};},
  async sendList(...args){calls.push(['list',...args]);return {messages:[{id:'fake'}]};}
 };
 const store={conv,createInvite:(from,amount)=>{calls.push(['invite',from,amount]);return 'token-test';}};
 const api=createWebhook({messenger,store,log:{log(){},error(){}},baseUrl:'https://pagos.kashbit.bond'});
 async function send(body,type='text'){
  const msg={type,from:'5215500000000'};
  if(type==='text')msg.text={body};
  else msg.interactive={list_reply:{id:body}};
  await api.handleWebhook({entry:[{changes:[{value:{messages:[msg]}}]}]});
 }
 return {calls,conv,send,api};
}
test('list respects Meta limits and whitelists actions',()=>{
 const sections=nav.menuSections(),rows=sections.flatMap(s=>s.rows);
 assert.equal(rows.length,8);
 assert.ok(rows.length<=10);
 assert.equal(new Set(rows.map(r=>r.id)).size,8);
 rows.forEach(r=>{assert.ok(r.title.length<=24);assert.ok(r.description.length<=72);});
 assert.equal(nav.selection({type:'interactive',interactive:{button_reply:{id:'menu:charge'}}}),'charge');
 assert.equal(nav.selection({type:'interactive',interactive:{list_reply:{id:'menu:pin'}}}),'pin');
 assert.equal(nav.selection({type:'interactive',interactive:{list_reply:{id:'menu:unknown'}}}),null);
});
test('existing cobrar and amount produce original link',async()=>{
 const f=fixture();
 await f.send('cobrar');
 assert.equal(f.conv.get('5215500000000').step,'amount');
 assert.match(f.calls[0][2],/¿Cuánto quieres cobrar/);
 await f.send('1000');
 assert.deepEqual(f.calls[1],['invite','5215500000000',1000]);
 assert.match(f.calls[2][2],/\/pay\/request\/token-test/);
 assert.equal(f.conv.size,0);
});
test('menu opens list and interactive charge asks amount',async()=>{
 const f=fixture();
 await f.send('menu');
 assert.equal(f.calls[0][0],'list');
 await f.send('menu:charge','interactive');
 assert.equal(f.conv.get('5215500000000').step,'amount');
});
test('microapp links are static and have no financial entry fields',async()=>{
 for(const route of Object.keys(PAGES)){
  const f=fixture();
  await f.send('menu:'+route,'interactive');
  assert.ok(f.calls[0][2].includes('/pay/app/'+route));
  assert.ok(f.calls[0][2].includes('preparación'));
  const html=renderPage(route);
  assert.match(html,/Módulo en preparación/);
  assert.equal(/<form\b/.test(html),false);
 }
 assert.equal(renderPage('unknown'),null);
});
test('invalid amount does not create invite and menu leaves amount state',async()=>{
 const f=fixture();
 await f.send('cobrar');await f.send('abc');
 assert.equal(f.conv.get('5215500000000').step,'amount');
 await f.send('menú');
 assert.equal(f.conv.size,0);
 assert.equal(f.calls[2][0],'list');
});
test('status callback is ignored',async()=>{
 const f=fixture();
 await f.api.handleWebhook({entry:[{changes:[{value:{statuses:[{id:'fake'}]}}]}]});
 assert.equal(f.calls.length,0);
});
