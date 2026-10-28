'use strict';
(function(){
 const root=document.querySelector('main'),form=document.getElementById('enroll-card');
 if(!root||!form)return;
 const status=document.getElementById('status'),button=document.getElementById('submit');
 const value=id=>document.getElementById(id).value;
 const clear=()=>{document.getElementById('pan').value='';document.getElementById('cvv').value='';};
 const say=text=>{status.textContent=text;};
 try{
  if(!window.OpenPay||!OpenPay.deviceData?.setup)throw Error('Openpay no disponible');
  OpenPay.setId(root.dataset.merchant);
  OpenPay.setApiKey(root.dataset.publicKey);
  OpenPay.setSandboxMode(true);
  const device=OpenPay.deviceData.setup('enroll-card','device-id');
  if(!device)throw Error('No se generó device_session_id');
  button.disabled=false;
  say('Listo para una tarjeta de prueba.');
 }catch(e){say(e.message);}
 form.addEventListener('submit',event=>{
  event.preventDefault();
  button.disabled=true;
  const profile={firstName:value('first'),lastName:value('last')};
  const details={
   holder_name:value('holder'),
   card_number:value('pan'),
   expiration_month:value('month'),
   expiration_year:value('year'),
   cvv2:value('cvv')
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
       ...profile,tokenId,deviceSessionId:value('device-id'),
       consent:document.getElementById('consent').checked
      })
     });
     if(!resp.ok)throw Error('Registro no confirmado: consulta tus tarjetas antes de repetir.');
     const card=await resp.json();
     say('Tarjeta registrada: '+card.brand+' •••• '+card.last4);
    }catch(e){say(e.message);}
    finally{button.disabled=false;}
   },_error=>{
    clear();say('Tokenización rechazada por Openpay.');
    button.disabled=false;
   });
  }catch(e){
   clear();say('No se pudo tokenizar la tarjeta.');
   button.disabled=false;
  }
 });
})();
