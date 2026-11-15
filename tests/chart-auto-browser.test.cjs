/* Current production UI; all provider/private responses are controlled local data. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const fs=require('node:fs'), path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../frontend');
let server,browser,origin,model;
function fresh(){return {connected:false,calls:[],balances:{'DOT-test':10000,'ROT-test':2500},transactions:[],contracts:[],run:null,chartEnabled:true,balanceError:null,historyError:null};}
function view(id='DOT-test'){
 const type=id.startsWith('ROT')?'real':'demo',currency='USD';
 return {authorization_status:'authorised',read_only:true,csrf:'mock-csrf',session_view:'mock-session',owner:'Account tester',accounts:[{id:'DOT-test',type:'demo',currency:'USD',read_only:true},{id:'ROT-test',type:'real',currency:'USD',read_only:true}],selected_account:{id,type,currency,balance:model.balances[id],read_only:true},balance_status:model.balanceError?'unavailable':'available',balance_updated_at:1000,balance_error:model.balanceError,transactions:model.transactions,contracts:model.contracts,statement_updated_at:model.historyError?null:1000,contracts_updated_at:model.historyError?null:1000,statement_error:model.historyError,contracts_error:model.historyError};
}
before(async()=>{
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,origin||'http://localhost'),chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store, private'});res.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/deriv/')){
   model.calls.push({path:url.pathname,method:req.method,body,selected:url.searchParams.get('account_id')});
   if(url.pathname==='/api/deriv/chart/config')return send(200,{enabled:model.chartEnabled,demo_enabled:true,real_enabled:true,ai_configured:true,node_available:true});
   if(url.pathname.startsWith('/api/deriv/chart/')) {
    if(!model.connected)return send(401,{detail:'Sign in'});
    if(req.method==='POST' && req.headers['x-deriv-csrf']!=='mock-csrf')return send(403,{detail:'CSRF failed'});
    if(url.pathname.endsWith('/status'))return send(200,{run:model.run});
    if(url.pathname.endsWith('/start')){model.run={id:'controlled-run',...body,status:'running',net:0,wins:0,losses:0,settled:0,history:[],note:'WAIT — original strategy checks',pending:null};return send(200,model.run);}
    if(url.pathname.endsWith('/control')){model.run.status=body.action==='pause'?'paused':body.action==='resume'?'running':'stopped';return send(200,model.run);}
   }
   if(url.pathname.endsWith('/config'))return send(200,{oauth_ready:true,app_id:'public-test-app'});
   if(['/api/deriv/session','/api/deriv/token'].includes(url.pathname)&&req.method==='POST'){
    model.connected=true;res.setHeader('Set-Cookie','test-session=present; HttpOnly; SameSite=Lax; Path=/api/deriv');return send(200,{csrf:'mock-csrf'});
   }
   if(!model.connected)return send(401,{detail:'Sign in with Deriv again'});
   if(url.pathname==='/api/deriv/disconnect'){model.connected=false;return send(200,{connected:false});}
   if(url.pathname==='/api/deriv/account-display')return send(200,view(url.searchParams.get('account_id')||'DOT-test'));
   return send(403,{detail:'Orders forbidden in account display tests'});
  }
  const files={'/':'index.html','/chart-auto.js':'public/chart-auto.js','/account.js':'public/account.js','/matches-simulator.js':'public/matches-simulator.js','/matches-lab.js':'public/matches-lab.js','/styles.css':'public/styles.css','/favicon.svg':'public/favicon.svg','/research-evidence.json':'public/research-evidence.json'};
  if(!files[url.pathname]){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(path.join(root,files[url.pathname])));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function open(t,{mobile=false,login=true,oauth=false,enabled=true}={}){
 model=fresh();model.chartEnabled=enabled;
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});t.after(()=>context.close());
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.addInitScript(({oauth})=>{
  sessionStorage.setItem('del.cred',JSON.stringify({token:'old-private-token-canary'}));
  if(oauth)sessionStorage.setItem('del.pkce',JSON.stringify({state:'test-state',verifier:'x'.repeat(43)}));
  window.__notes=[];window.AudioContext=class{state='running';currentTime=0;destination={};resume(){}close(){}createGain(){return{gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){return this;}};}createOscillator(){return{frequency:{},connect(g){return g;},start(){window.__notes.push(this.frequency.value);},stop(){}};}};
  window.__requests=[];window.__epoch=1000;window.WebSocket=class{
   static OPEN=1;
   constructor(url){if(!url.endsWith('/ws/public'))throw new Error('Authenticated socket forbidden in browser');this.readyState=0;window.__socket=this;queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
   send(raw){const q=JSON.parse(raw);window.__requests.push(q);if(!('ticks'in q||'ticks_history'in q||'forget_all'in q||'ping'in q||q.proposal===1&&q.contract_type==='DIGITMATCH'))throw new Error('Non-market command forbidden');const history=q.ticks_history?(window.__historyError?{error:{code:'Unavailable'}}:{history:{prices:Array.from({length:200},(_,i)=>i===199?100.01:window.__noAgreement&&i<150?100.02:100.07),times:Array.from({length:200},(_,i)=>window.__epoch-398+i*2)},pip_size:2}):{};const message=q.proposal?(window.__quoteInvalid?{error:{code:'MockUnavailable'}}:{proposal:{id:'public-quote-'+q.req_id,ask_price:q.amount,payout:Math.round(q.amount*8.33*100)/100},echo_req:q}):history;setTimeout(()=>this.onmessage?.({data:JSON.stringify({...message,req_id:q.req_id})}),0);}
   close(){this.readyState=3;this.onclose?.();}
  };
  window.__tick=(quote=100.01)=>{window.__epoch+=2;window.__socket.onmessage({data:JSON.stringify({msg_type:'tick',tick:{symbol:document.getElementById('symbol-select').value,quote,pip_size:2,epoch:window.__epoch}})});};
 },{oauth});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+(oauth?'/#code=synthetic-code&state=test-state':'/'));
 await page.waitForFunction(()=>window.__requests.some(q=>q.ticks));await page.evaluate(()=>window.__tick());
 if(login&&!oauth){await page.waitForFunction(()=>!state.checking);await page.locator('#connect-button').click();await page.locator('#token-details > summary').click();await page.locator('#token-input').fill('private-login-canary');await page.locator('#token-connect-button').click();}
 if(login||oauth)await page.waitForFunction(()=>state.auth==='authorised'&&!state.checking);
 return page;
}



test('automatic phone controls replace digit practice without a wallet or price guesses',{timeout:15000},async t=>{
 const page=await open(t,{mobile:true});await page.waitForSelector('#chart-testing');
 await page.waitForFunction(()=>!document.getElementById('chart-start').disabled);
 assert.equal(await page.locator('#matches-testing').isVisible(),false);
 assert.equal(await page.locator('#chart-testing input[type=number]').count(),3);
 assert.equal(await page.locator('#chart-start').isDisabled(),false);
 assert.equal(await page.locator('#chart-live-choice').isVisible(),false);
 assert.equal(await page.locator('#chart-testing #result-flash').count(),1);
 assert.equal(await page.locator('#chart-error').isVisible(),false);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=2);
 assert.equal(model.calls.some(c=>c.path.endsWith('/chart/start')),false);
 await page.screenshot({path:'/tmp/deriv-chart-auto-mobile.png',fullPage:true});
});

test('Start sends the selected Demo account, fixed amounts and existing CSRF; controls freeze settings',{timeout:15000},async t=>{
 const page=await open(t);await page.waitForSelector('#chart-testing');await page.locator('#chart-stake').fill('2');
 await page.locator('#chart-target').fill('4');await page.locator('#chart-loss').fill('6');await page.locator('#chart-start').click();
 await page.waitForFunction(()=>document.getElementById('chart-pause').disabled===false);
 const request=model.calls.find(c=>c.path.endsWith('/chart/start'));
 assert.deepEqual(request.body,{account_id:'DOT-test',mode:'demo',symbol:'R_100',stake:2,target:4,max_loss:6,acknowledge_live:false});
 assert.equal(await page.locator('#account-select').isDisabled(),true);assert.equal(await page.locator('#chart-stake').isDisabled(),true);
 await page.locator('#chart-pause').click();await page.waitForFunction(()=>document.getElementById('chart-pause').textContent==='Resume');
 await page.locator('#chart-pause').click();await page.waitForFunction(()=>document.getElementById('chart-pause').textContent==='Pause');
 await page.locator('#chart-stop').click();await page.waitForFunction(()=>!document.getElementById('chart-start').disabled);
 assert.deepEqual(model.calls.filter(c=>c.path.endsWith('/control')).map(c=>c.body.action),['pause','resume','stop']);
 assert.match(await page.locator('#balance-value').innerText(),/10,000.00/);
});

test('Live requires explicit account selection and checkbox; no orders start on account switch',{timeout:15000},async t=>{
 const page=await open(t);await page.waitForSelector('#chart-testing');await page.locator('#account-select').selectOption('ROT-test');
 await page.waitForFunction(()=>state.view?.selected_account.id==='ROT-test');
 await page.waitForFunction(()=>!document.getElementById('chart-live-choice').hidden);
 assert.equal(await page.locator('#chart-start').isDisabled(),true);assert.equal(model.run,null);
 await page.locator('#chart-live-confirm').check();await page.locator('#chart-start').click();
 await page.waitForFunction(()=>document.getElementById('chart-pause').disabled===false);
 assert.equal(model.run.mode,'real');assert.equal(model.run.account_id,'ROT-test');assert.equal(model.run.acknowledge_live,true);
});

test('reload restores server session state without another Start or a fictional balance',{timeout:15000},async t=>{
 const page=await open(t);await page.waitForSelector('#chart-testing');await page.locator('#chart-start').click();
 await page.waitForFunction(()=>document.getElementById('chart-pause').disabled===false);model.run.net=-1;model.run.losses=1;model.run.settled=1;model.run.win_rate=0;
 await page.reload();await page.waitForFunction(()=>document.getElementById('chart-pnl')?.textContent==='-$1.00');
 assert.equal(model.calls.filter(c=>c.path.endsWith('/chart/start')).length,1);
 assert.match(await page.locator('#balance-value').innerText(),/10,000.00/);
 assert.equal(await page.locator('#chart-start').isDisabled(),true);
});

test('disabled server flag preserves the working existing page without automatic controls',{timeout:15000},async t=>{
 const page=await open(t,{enabled:false});assert.equal(await page.locator('#chart-testing').count(),0);
 assert.equal(await page.locator('#matches-testing').isVisible(),true);
 assert.equal(model.calls.some(c=>c.path.endsWith('/chart/start')),false);
});
