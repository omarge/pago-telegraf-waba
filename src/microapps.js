'use strict';
// F01 is a read-only navigation shell, NOT a card or account backend.
const PAGES={
 pay:['Pagar','Para pagar, abre el enlace de cobro recibido en WhatsApp. El checkout actual no cambia.'],
 cards:['Mis tarjetas','La consulta autenticada de tarjetas se incorporará posteriormente.'],
 enroll:['Guardar tarjeta','El enrolamiento de Openpay estará disponible cuando se integre el módulo de tarjetas.'],
 pin:['Mi NIP','El NIP KashBitPay se configurará con una sesión de cuenta. No lo envíes por WhatsApp.'],
 statement:['Estado de cuenta','Próximamente podrás consultar movimientos verificados.'],
 settings:['Configuración','Próximamente podrás administrar los datos de tu cuenta.'],
 receipts:['Comprobantes','Próximamente podrás consultar tus recibos de pago.']
};
function renderPage(route='home'){
 const item=route==='home'?null:PAGES[route];
 if(route!=='home'&&!item)return null;
 const heading=item?item[0]:'KashBitPay';
 const menu=Object.keys(PAGES).map(key=>'<a href="/pay/app/'+key+'">'+PAGES[key][0]+' ›</a>').join('');
 const body=item?
  '<h1>'+heading+'</h1><p>'+item[1]+'</p>'+
  '<p class="info">Módulo en preparación. Esta página no realiza operaciones.</p>'+
  '<a href="/pay/app">← Volver</a>':
  '<h1>KashBitPay</h1><p>Selecciona una microaplicación.</p><nav>'+menu+'</nav>';
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<title>'+heading+' · KashBitPay</title><style>'+
 'body{font:16px system-ui;background:#f1f6f7;color:#173543;padding:20px}'+
 'main{max-width:480px;background:white;margin:auto;padding:24px;border-radius:16px}'+
 'h1{font-size:1.7rem}p{line-height:1.5}a{display:block;padding:14px;'+
 'color:#09696c;text-decoration:none;border-bottom:1px solid #ddd}'+
 '.info{background:#f1f6f7;padding:12px;border-radius:8px}'+
 '</style></head><body><main>'+body+'</main></body></html>';
}
module.exports={PAGES,renderPage};
