'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../src/enrollClient.js'),'utf8');
function runBrowser(onCreate,{fetchRequest=async()=>{throw Error('Unexpected backend request');}}={}) {
 const values={
  first:'Prueba',last:'Sandbox',holder:'Persona Prueba',
  pan:'4111 1111-1111 1111',month:' 12 ',year:' 29 ',
  cvv:' 123 ',consent:'',submit:'',status:'', 'device-id':'',
  'enroll-card':''
 };
 let onSubmit;
 const elements=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{
  value:v,textContent:'',disabled:true,checked:k==='consent',
  addEventListener(_name,fn){onSubmit=fn;}
 }]));
 const root={dataset:{merchant:'merchant1234',publicKey:'pk_test_dummy',csrf:'csrf-dummy'}};
 const openpay={
  setId(){},setApiKey(){},setSandboxMode(){},
  deviceData:{setup(){return 'device_test_123456';}},
  token:{create:onCreate}
 };
 const context={document:{
  querySelector(){return root;},
  getElementById(id){return elements[id];}
 },window:{OpenPay:openpay},OpenPay:openpay,fetch:fetchRequest};
 vm.runInNewContext(code,context);
 assert.equal(elements.submit.disabled,false);
 onSubmit({preventDefault(){}});
 return elements;
}
test('F03: token creation removes spaces and hyphens before Openpay.js',()=>{
 let body;
 const elements=runBrowser((details,_success,failure)=>{
  body=details;failure({data:{error_code:2004}});
 });
 assert.equal(body.card_number,'4111111111111111');
 assert.equal(body.expiration_month,'12');
 assert.equal(body.expiration_year,'29');
 assert.equal(body.cvv2,'123');
 assert.match(elements.status.textContent,/Código 2004/);
 assert.equal(elements.pan.value,'');
 assert.equal(elements.cvv.value,'');
});
test('F03: show only numeric error code; never echo sensitive error descriptions',()=>{
 const secret='PAN-4111111111111111-and-secret';
 const elements=runBrowser((_details,_success,failure)=>failure({
  status:422,data:{error_code:'2004',description:secret,card_number:secret}
 }));
 assert.match(elements.status.textContent,/Código 2004/);
 assert.match(elements.status.textContent,/HTTP 422/);
 assert.doesNotMatch(elements.status.textContent,/4111111111111111/);
 assert.doesNotMatch(elements.status.textContent,/secret/);
});
test('F03: unknown Openpay failure does not disclose arbitrary response body',()=>{
 const elements=runBrowser((_details,_success,failure)=>failure({
  data:{error_code:'invalid-secret-text',description:'Sensitive info'}
 }));
 assert.match(elements.status.textContent,/Tokenización rechazada por Openpay/);
 assert.doesNotMatch(elements.status.textContent,/invalid-secret-text|Sensitive info/);
});

test('F03 Openpay.js: AJAX sends returned device session ID even when existing hidden field is empty',async()=>{
 const submissions=[];
 const elements=runBrowser((_cardDetails,success)=>{
  success({data:{id:'token_f03_abcdef01234567'}});
 },{fetchRequest:async(url,options)=>{
  assert.equal(url,'/pay/app/api/cards/enroll');
  submissions.push(JSON.parse(options.body));
  return {ok:true,json:async()=>({id:'card_test_12345678',brand:'visa',last4:'1111'})};
 }});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(submissions.length,1);
 assert.equal(submissions[0].deviceSessionId,'device_test_123456');
 assert.equal(submissions[0].tokenId,'token_f03_abcdef01234567');
 assert.equal(submissions[0].consent,true);
 assert.match(elements.status.textContent,/Tarjeta registrada/);
 assert.doesNotMatch(elements.status.textContent,/token_f03_|device_test_/);
});
