'use strict';
const express=require('express');
const {accountService}=require('./accountService');
const {renderPage}=require('./microapps');
const {createCardRoutes}=require('./cardRoutes');
const {createSavedCardRoutes}=require('./savedCardRoutes');
const {createStatementRoutes}=require('./statementRoutes');
const {statementJournal}=require('./statementJournal');
const paymentStore=require('./store');
const {sendMessage}=require('./waba');
const COOKIE='kashbit_web_session';
const MAX_AGE=8*60*60*1000;
function escapeHtml(x){
 return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function layout(title,body){
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta name="referrer" content="no-referrer">'+
 '<title>'+escapeHtml(title)+' · KashBitPay</title><style>'+
 'body{background:#f2f6f7;color:#183044;font:16px system-ui;padding:20px}'+
 'main{max-width:460px;background:#fff;border-radius:15px;padding:24px;margin:auto}'+
 'input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin-top:7px}'+
 'label{display:block;margin-top:14px}button{background:#146970;color:white;border:0;border-radius:7px}'+
 'a{display:block;color:#146970;margin-top:16px}p{line-height:1.5}code{overflow-wrap:anywhere}'+
 '.error{color:#b42318}.hint{background:#edf5f5;padding:12px;border-radius:8px}'+
 '</style></head><body><main>'+body+'</main></body></html>';
}
function cookieToken(req){
 const header=String(req.headers.cookie||'');
 const found=header.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
 return found?found.slice(COOKIE.length+1):null;
}
function safeReturnPath(value){
 return typeof value==='string'&&/^\/pay\/app\/pay\/KPR-[0-9A-F]{32}$/.test(value)?value:null;
}
function createAccountRouter({service=accountService,vault,requestStore=paymentStore,notifier=sendMessage,journal=statementJournal,savedCardEnabled=process.env.WABA_SAVED_CARD_PAY_SANDBOX==='1'}={}){
 const router=express.Router();
 router.use(express.urlencoded({extended:false,limit:'8kb'}));
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
 function session(req){return service.getSession(cookieToken(req));}
 function requireSession(req,res,next){
  const data=session(req);
  if(!data){
   const returnTo=safeReturnPath(req.originalUrl);
   return res.redirect(303,'/pay/app/login'+(returnTo?'?next='+encodeURIComponent(returnTo):''));
  }
  req.account=data;
  req.sessionToken=cookieToken(req);
  next();
 }
 function setSessionCookie(res,token){
  res.cookie(COOKIE,token,{httpOnly:true,secure:true,sameSite:'lax',path:'/pay/app',maxAge:MAX_AGE});
 }
 function authForm(kind,error='',returnTo=null){
  const register=kind==='register',title=register?'Crear cuenta':'Ingresar';
  return layout(title,'<h1>'+title+'</h1><p>Cuenta KashBitPay para microaplicaciones.</p>'+
   (error?'<p class="error">'+escapeHtml(error)+'</p>':'')+
   '<form method="post" action="/pay/app/'+kind+'">'+
   (safeReturnPath(returnTo)?'<input type="hidden" name="next" value="'+escapeHtml(returnTo)+'">':'')+
   '<label>Correo<input type="email" name="email" maxlength="254" autocomplete="username" required></label>'+
   '<label>Contraseña<input type="password" name="password" minlength="12" maxlength="256" autocomplete="'+
   (register?'new-password':'current-password')+'" required></label>'+
   '<button type="submit">'+title+'</button></form>'+
   '<a href="/pay/app/'+(register?'login':'register')+(safeReturnPath(returnTo)?'?next='+encodeURIComponent(returnTo):'')+'">'+
   (register?'Ya tengo cuenta':'Crear cuenta nueva')+'</a>');
 }
 router.get('/login',(req,res)=>{
  if(session(req))return res.redirect(303,'/pay/app');
  res.type('html').send(authForm('login','',req.query.next));
 });
 router.get('/register',(req,res)=>{
  if(session(req))return res.redirect(303,'/pay/app');
  res.type('html').send(authForm('register','',req.query.next));
 });
 router.post('/register',(req,res)=>{
  try{
   const {token}=service.register(req.body?.email,req.body?.password);
   setSessionCookie(res,token);
   return res.redirect(303,safeReturnPath(req.body?.next)||'/pay/app/account');
  }catch(error){return res.status(400).type('html').send(authForm('register',error.message,req.body?.next));}
 });
 router.post('/login',(req,res)=>{
  const result=service.login(req.body?.email,req.body?.password);
  if(!result)return res.status(401).type('html').send(authForm('login','Credenciales incorrectas',req.body?.next));
  setSessionCookie(res,result.token);
  return res.redirect(303,safeReturnPath(req.body?.next)||'/pay/app/account');
 });
 router.get('/api/session',requireSession,(req,res)=>{
  const {accountId,email,whatsappLinked}=req.account;
  res.json({accountId,email,whatsappLinked});
 });
 router.get('/account',requireSession,(req,res)=>{
  const a=req.account;
  res.type('html').send(layout('Mi cuenta',
   '<h1>Mi cuenta</h1><p>Correo: '+escapeHtml(a.email)+'</p>'+
   '<p>WhatsApp: '+(a.whatsappLinked?'vinculado':'sin vincular')+'</p>'+
   '<a href="/pay/app/bind">Vincular WhatsApp</a>'+
   '<a href="/pay/app">Microaplicaciones</a>'+
   '<form method="post" action="/pay/app/logout">'+
   '<input type="hidden" name="_csrf" value="'+escapeHtml(a.csrf)+'">'+
   '<button type="submit">Cerrar sesión</button></form>'));
 });
 router.get('/bind',requireSession,(req,res)=>{
  const a=req.account;
  res.type('html').send(layout('Vincular WhatsApp',
   '<h1>Vincular WhatsApp</h1><p>Estado: '+(a.whatsappLinked?'ya vinculado':'sin vincular')+'</p>'+
   '<p>Se solicitará un código de un solo uso. Debes enviarlo al bot desde el WhatsApp que deseas asociar.</p>'+
   '<form method="post" action="/pay/app/bind">'+
   '<input type="hidden" name="_csrf" value="'+escapeHtml(a.csrf)+'">'+
   '<button type="submit">Generar código</button></form>'+
   '<a href="/pay/app/account">← Mi cuenta</a>'));
 });
 router.post('/bind',requireSession,(req,res)=>{
  const result=service.beginLink(cookieToken(req),req.body?._csrf);
  if(!result)return res.sendStatus(403);
  if(result.alreadyLinked)return res.redirect(303,'/pay/app/account');
  res.type('html').send(layout('Vincular WhatsApp',
   '<h1>Vincular WhatsApp</h1>'+
   '<p>Desde tu WhatsApp envía este mensaje al bot KashBitPay:</p>'+
   '<p class="hint"><code>vincular '+escapeHtml(result.code)+'</code></p>'+
   '<p>El código vence en 10 minutos y solo se usa una vez.</p>'+
   '<a href="/pay/app/account">Volver a mi cuenta</a>'));
 });
 router.post('/logout',requireSession,(req,res)=>{
  if(!service.validCsrf(cookieToken(req),req.body?._csrf))return res.sendStatus(403);
  service.logout(cookieToken(req));
  res.clearCookie(COOKIE,{httpOnly:true,secure:true,sameSite:'lax',path:'/pay/app'});
  return res.redirect(303,'/pay/app/login');
 });
 const cardApp=createCardRoutes({accounts:service,vault});
 const savedPay=createSavedCardRoutes({
  accounts:service,vault:cardApp.vault,requestStore,notifier,journal,enabled:savedCardEnabled
 });
 router.use('/',requireSession,savedPay.router);
 router.use('/',requireSession,createStatementRoutes({accounts:service,journal}));
 router.use('/api/cards',requireSession,cardApp.api);
 router.get('/assets/enroll.js',requireSession,cardApp.enrollScript);
 router.get('/cards',requireSession,cardApp.cards);
 router.get('/enroll',requireSession,cardApp.enroll);
 router.get('/pin',requireSession,cardApp.pinGet);
 router.post('/pin',requireSession,cardApp.pinPost);
 router.get('/',requireSession,(_req,res)=>res.type('html').send(renderPage()));
 router.get('/:feature',requireSession,(req,res)=>{
  const html=renderPage(req.params.feature);
  if(!html)return res.sendStatus(404);
  return res.type('html').send(html);
 });
 return router;
}
module.exports={createAccountRouter,COOKIE};
