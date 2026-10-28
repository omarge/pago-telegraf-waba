'use strict';
const ITEMS=[
 ['charge','Cobrar','Crear enlace de cobro'],
 ['pay','Pagar','Abrir opciones de pago'],
 ['cards','Mis tarjetas','Consultar tarjetas guardadas'],
 ['enroll','Guardar tarjeta','Registrar tarjeta'],
 ['pin','Mi NIP','NIP KashBitPay'],
 ['statement','Estado de cuenta','Ver movimientos'],
 ['settings','Configuración','Editar preferencias'],
 ['receipts','Comprobantes','Ver comprobantes']
];
const TEXT={
 menu:'main','menú':'main','/menu':'main',inicio:'main',ayuda:'main',
 pagar:'pay',tarjetas:'cards','guardar tarjeta':'enroll',nip:'pin',
 'mi nip':'pin','estado de cuenta':'statement',movimientos:'statement',
 configuracion:'settings','configuración':'settings',comprobantes:'receipts'
};
function menuSections(){
 return [{title:'KashBitPay',rows:ITEMS.map(([route,title,description])=>({
   id:'menu:'+route,title,description
 }))}];
}
function selection(msg){
 if(msg?.type==='interactive'){
  const id=msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id;
  if(id==='menu:main')return 'main';
  if(typeof id==='string' && ITEMS.some(item=>'menu:'+item[0]===id))return id.slice(5);
  return null;
 }
 if(msg?.type!=='text')return null;
 const text=String(msg.text?.body||'').trim().toLowerCase();
 return TEXT[text]||null;
}
function link(route,base){
 if(route==='charge'||!ITEMS.some(item=>item[0]===route))return null;
 return String(base||'https://pagos.kashbit.bond').replace(/\/+$/,'')+'/pay/app/'+route;
}
module.exports={ITEMS,menuSections,selection,link};
