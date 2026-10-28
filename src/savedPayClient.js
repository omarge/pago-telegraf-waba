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
  // The return value is authoritative for regular POST forms as well as AJAX.
  // A separately rendered hidden input can remain empty after Openpay.js setup.
  const device=OpenPay.deviceData.setup('saved-payment','openpay-device-session');
  if(typeof device!=='string'||!/^[A-Za-z0-9_-]{8,255}$/.test(device))
   throw Error('No se obtuvo sesión del dispositivo válida.');
  const sessionField=document.getElementById('device-id');
  if(!sessionField)throw Error('Campo de sesión del dispositivo ausente.');
  sessionField.value=device;
  button.disabled=false;
  status.textContent='Listo para confirmar.';
 }catch(error){status.textContent=error.message;}
 form.addEventListener('submit',()=>{button.disabled=true;status.textContent='Procesando pago…';});
})();
