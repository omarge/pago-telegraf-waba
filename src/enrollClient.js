'use strict';
(function(){
 const root=document.querySelector('main'),form=document.getElementById('enroll-card');
 if(!root||!form)return;
 const status=document.getElementById('status'),button=document.getElementById('submit');
 const value=id=>document.getElementById(id).value;
 const clear=()=>{document.getElementById('pan').value='';document.getElementById('cvv').value='';};
 const say=text=>{status.textContent=text;};
 let deviceSessionId='';
 const safeCode=error=>{
  const code=error?.data?.error_code ?? error?.error_code;
  const text=String(code??'');
  return /^[0-9]{3,6}$/.test(text)?text:null;
 };
 const safeHttpCode=error=>{
  const code=error?.status ?? error?.data?.http_code;
  const text=String(code??'');
  return /^[1-5][0-9]{2}$/.test(text)?text:null;
 };
 try{
  if(!window.OpenPay||!OpenPay.deviceData?.setup)throw Error('Openpay no disponible');
  OpenPay.setId(root.dataset.merchant);
  OpenPay.setApiKey(root.dataset.publicKey);
  OpenPay.setSandboxMode(true);
  // Openpay.js returns the session ID and may also add its own hidden input.
  // Never read a separately pre-created empty field for an AJAX request.
  const device=OpenPay.deviceData.setup('enroll-card','openpay-device-session');
  if(typeof device!=='string'||!/^[A-Za-z0-9_-]{8,255}$/.test(device))
   throw Error('No se generó device_session_id válido');
  deviceSessionId=device;
  button.disabled=false;
  say('Listo para una tarjeta de prueba.');
 }catch(e){say(e.message);}
 form.addEventListener('submit',event=>{
  event.preventDefault();
  button.disabled=true;
  const profile={firstName:value('first'),lastName:value('last')};
  const details={
   holder_name:value('holder'),
   card_number:value('pan').replace(/[\s-]/g,''),
   expiration_month:value('month').trim(),
   expiration_year:value('year').trim(),
   cvv2:value('cvv').trim()
  };
  say('Tokenizando directamente con Openpay…');
  try{
   OpenPay.token.create(details,async response=>{
    clear();
    try{
     const tokenId=response?.data?.id;
     if(!tokenId)throw Error('Tokenización no confirmada');
     const resp=await fetch('/pay/app/api/cards/enroll',{
      method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-CSRF-Token':root.dataset.csrf},
      body:JSON.stringify({
       ...profile,tokenId,deviceSessionId,
       consent:document.getElementById('consent').checked
      })
     });
     if(!resp.ok){
      const result=await resp.json().catch(()=>null);
      const stages={CREATE_CUSTOMER:'CREATE_CUSTOMER',STORE_CUSTOMER:'STORE_CUSTOMER',
       CREATE_CARD:'CREATE_CARD',GET_CARD:'GET_CARD',VERIFY_CARD:'VERIFY_CARD',
       STORE_CARD:'STORE_CARD',VALIDATION:'VALIDATION',
       VALIDATE_CONSENT:'VALIDATE_CONSENT',VALIDATE_TOKEN:'VALIDATE_TOKEN',
       VALIDATE_DEVICE:'VALIDATE_DEVICE',VALIDATE_NAME:'VALIDATE_NAME',
       VALIDATE_EMAIL:'VALIDATE_EMAIL',VALIDATE_LIMIT:'VALIDATE_LIMIT'};
      const stage=stages[result?.stage]||'UNKNOWN';
      const code=/^[0-9]{3,6}$/.test(String(result?.openpayCode??''))?result.openpayCode:null;
      const http=Number.isInteger(result?.openpayHttpStatus)&&result.openpayHttpStatus>=400&&result.openpayHttpStatus<=599?result.openpayHttpStatus:null;
      throw Error('Registro no confirmado (etapa '+stage+')'+
       (http?' Openpay HTTP '+http:'')+(code?' código '+code:'')+
       '. Consulta Mis tarjetas antes de repetir.');
     }
     const card=await resp.json();
     say('Tarjeta registrada: '+card.brand+' •••• '+card.last4);
    }catch(e){say(e.message);}
    finally{button.disabled=false;}
   },error=>{
    // Do not display or log the untrusted response body, card data or tokens.
    const code=safeCode(error),http=safeHttpCode(error);
    clear();
    say('Tokenización rechazada por Openpay.'+
      (code?' Código '+code+'.':'')+
      (http?' HTTP '+http+'.':'')+
      ' Revisa los datos de prueba y la configuración de Openpay Sandbox.');
    button.disabled=false;
   });
  }catch(e){
   clear();say('No se pudo tokenizar la tarjeta.');
   button.disabled=false;
  }
 });
})();
