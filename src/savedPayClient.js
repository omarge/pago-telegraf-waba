'use strict';
(function(){
 const form=document.getElementById('saved-payment'),button=document.getElementById('confirm');
 if(!form)return;
 const status=document.getElementById('device-status');
 try{
  if(!window.OpenPay?.deviceData?.setup)throw Error('No se pudo inicializar Openpay Sandbox.');
  OpenPay.setId(form.dataset.mid);
  OpenPay.setApiKey(form.dataset.pk);
  OpenPay.setSandboxMode(true);
  const device=OpenPay.deviceData.setup('saved-payment','device-id');
  if(!device)throw Error('No se obtuvo sesión del dispositivo.');
  button.disabled=false;
  status.textContent='Listo para confirmar.';
 }catch(error){status.textContent=error.message;}
 form.addEventListener('submit',()=>{button.disabled=true;status.textContent='Procesando pago…';});
})();
