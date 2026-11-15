/* Current production UI; all provider/private responses are controlled local data. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const fs=require('node:fs'), path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../frontend');
let server,browser,origin,model;
function fresh(){return {connected:false,calls:[],balances:{'DOT-test':10000,'ROT-test':2500},transactions:[],contracts:[],balanceError:null,historyError:null};}
function view(id='DOT-test'){
 const type=id.startsWith('ROT')?'real':'demo',currency=type==='real'?'EUR':'USD';
 return {authorization_status:'authorised',read_only:true,csrf:'mock-csrf',session_view:'mock-session',owner:'Account tester',accounts:[{id:'DOT-test',type:'demo',currency:'USD',read_only:true},{id:'ROT-test',type:'real',currency:'EUR',read_only:true}],selected_account:{id,type,currency,balance:model.balances[id],read_only:true},balance_status:model.balanceError?'unavailable':'available',balance_updated_at:1000,balance_error:model.balanceError,transactions:model.transactions,contracts:model.contracts,statement_updated_at:model.historyError?null:1000,contracts_updated_at:model.historyError?null:1000,statement_error:model.historyError,contracts_error:model.historyError};
}
before(async()=>{
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,origin||'http://localhost'),chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store, private'});res.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/deriv/')){
   model.calls.push({path:url.pathname,method:req.method,body,selected:url.searchParams.get('account_id')});
   if(url.pathname.endsWith('/config'))return send(200,{oauth_ready:true,app_id:'public-test-app'});
   if(['/api/deriv/session','/api/deriv/token'].includes(url.pathname)&&req.method==='POST'){
    model.connected=true;res.setHeader('Set-Cookie','test-session=present; HttpOnly; SameSite=Lax; Path=/api/deriv');return send(200,{csrf:'mock-csrf'});
   }
   if(!model.connected)return send(401,{detail:'Sign in with Deriv again'});
   if(url.pathname==='/api/deriv/disconnect'){model.connected=false;return send(200,{connected:false});}
   if(url.pathname==='/api/deriv/account-display')return send(200,view(url.searchParams.get('account_id')||'DOT-test'));
   return send(403,{detail:'Orders forbidden in account display tests'});
  }
  const files={'/':'index.html','/account.js':'public/account.js','/matches-simulator.js':'public/matches-simulator.js','/matches-lab.js':'public/matches-lab.js','/styles.css':'public/styles.css','/favicon.svg':'public/favicon.svg','/research-evidence.json':'public/research-evidence.json'};
  if(!files[url.pathname]){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(path.join(root,files[url.pathname])));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function open(t,{mobile=false,login=true,oauth=false}={}){
 model=fresh();
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


async function quoted(page){await page.waitForFunction(()=>!!window.matchesLab?.quote);}

test('simple page: only account, market, three settings, controls and results remain',{timeout:15000},async t=>{
 const page=await open(t,{mobile:true});
 assert.equal(await page.locator('#matches-preset,#matches-digit,#matches-research,#saved-research,#matches-history,#account-transactions,#virtual-wallet,#digit-frequency').count(),0);
 assert.equal(await page.locator('#matches-testing input').count(),3);
 assert.equal(await page.locator('#matches-stake').inputValue(),'0.35');
 for(const name of ['start','pause','stop'])assert.equal(await page.locator('#matches-'+name).isVisible(),true);
 assert.match(await page.locator('footer').innerText(),/Practice only.*No account orders/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=2);
 await page.screenshot({path:'/tmp/deriv-simple-mobile-fixture.png',fullPage:true});
});

test('automatic selection: no manual digit; public history chooses 7 before the quote and subsequent entry',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-start').click();await quoted(page);
 assert.equal(await page.evaluate(()=>matchesLab.quote.digit),7);
 assert.equal(await page.evaluate(()=>matchesLab.engine.cfg.auto),true);
 await page.evaluate(()=>window.__tick(100.01));assert.equal(await page.locator('#matches-wins').innerText(),'0');
 await page.evaluate(()=>window.__tick(100.07));
 assert.equal(await page.locator('#matches-wins').innerText(),'1');assert.equal(await page.locator('#matches-pnl').innerText(),'+$2.57');
 assert.match(await page.locator('#matches-status').innerText(),/Target reached/);
 assert.match(await page.locator('#balance-value').innerText(),/10,000\.00/);
 assert.equal(model.calls.some(c=>c.path.includes('/demo/')),false);
 assert.deepEqual(await page.evaluate(()=>window.__notes.slice(-2)),[880,1318.5]);
});

test('automatic selection waits when 50/150/200 windows disagree and never creates default-digit trades',{timeout:15000},async t=>{
 const page=await open(t);
 await page.evaluate(()=>{window.__noAgreement=true;matchesLab.interrupt('New public observation test');window.__tick();});
 await page.locator('#matches-start').click();
 await page.waitForFunction(()=>document.getElementById('matches-status').textContent==='Waiting for a clear digit.');
 await page.evaluate(()=>{for(let i=0;i<5;i++)window.__tick(100.07);});
 assert.equal(await page.evaluate(()=>matchesLab.engine.trades),0);assert.equal(await page.evaluate(()=>matchesLab.engine.pending),null);
 assert.equal(await page.evaluate(()=>window.__requests.filter(q=>q.proposal).length),0);
 assert.equal(await page.locator('#matches-pause').isDisabled(),false);
});

test('unavailable public history builds from genuine live ticks without invented observations',{timeout:15000},async t=>{
 const page=await open(t);await page.evaluate(()=>{window.__historyError=true;matchesLab.interrupt('Reset observations');window.__tick();});
 await page.locator('#matches-start').click();await page.evaluate(()=>window.__tick());
 assert.match(await page.locator('#matches-status').innerText(),/Preparing automatic selection/);
 assert.equal(await page.evaluate(()=>matchesLab.engine.trades),0);assert.equal(await page.evaluate(()=>window.__requests.filter(q=>q.proposal).length),0);
});

test('simple controls: paused pending losses settle once and obey the full-stake loss limit',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-loss').fill('0.35');await page.locator('#matches-start').click();await quoted(page);
 await page.evaluate(()=>window.__tick());await page.locator('#matches-pause').click();await page.evaluate(()=>window.__tick());
 assert.equal(await page.locator('#matches-losses').innerText(),'1');assert.equal(await page.locator('#matches-pnl').innerText(),'−$0.35');
 assert.equal(await page.locator('#matches-start').innerText(),'New session');assert.match(await page.locator('#matches-status').innerText(),/loss limit/);
 assert.deepEqual(await page.evaluate(()=>window.__notes.slice(-2)),[220,164.8]);
});

test('simple controls: Stop prevents new entries and waits for the pending result',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-start').click();await quoted(page);await page.evaluate(()=>window.__tick());
 await page.locator('#matches-stop').click();assert.equal(await page.locator('#matches-start').isDisabled(),true);
 await page.evaluate(()=>window.__tick());assert.equal(await page.evaluate(()=>matchesLab.engine.status),'done');
 assert.equal(await page.locator('#matches-losses').innerText(),'1');
 await page.locator('#matches-start').click();assert.equal(await page.locator('#matches-losses').innerText(),'0');
});

test('read-only Demo/Real selection and refresh continue independently of automatic practice',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-start').click();await quoted(page);
 await page.locator('#account-select').selectOption('ROT-test');await page.waitForFunction(()=>state.view?.selected_account.id==='ROT-test'&&!state.checking);
 await page.evaluate(()=>{window.__tick();window.__tick();});
 assert.match(await page.locator('#balance-value').innerText(),/2,500\.00/);assert.equal(await page.locator('#balance-currency').innerText(),'EUR');
 assert.equal(await page.locator('#matches-pnl').innerText(),'−$0.35');
 await page.locator('#account-refresh').click();await page.waitForFunction(()=>!state.checking);
 assert.equal(await page.evaluate(()=>matchesLab.engine.trades),1);
 assert.equal(model.calls.some(c=>c.path.includes('/demo/')||c.path.endsWith('/account')),false);
});

test('refresh restores paused automatic settings without replaying sounds or starting orders',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-target').fill('10');await page.locator('#matches-start').click();await quoted(page);
 await page.evaluate(()=>{window.__tick();window.__tick();});await page.locator('#matches-pause').click();
 await page.reload();await page.waitForFunction(()=>window.__requests.some(q=>q.ticks));await page.evaluate(()=>window.__tick());
 assert.equal(await page.locator('#matches-start').innerText(),'Resume');assert.equal(await page.locator('#matches-losses').innerText(),'1');
 assert.deepEqual(await page.evaluate(()=>window.__notes),[]);assert.equal(model.calls.some(c=>c.path.includes('/demo/')),false);
});

test('refresh during a pending automatic entry marks it unresolved once and never invents a win',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-start').click();await quoted(page);await page.evaluate(()=>window.__tick());
 await page.reload();assert.match(await page.locator('#matches-count').innerText(),/1 unknown/);assert.equal(await page.locator('#matches-wins').innerText(),'0');
 await page.reload();assert.match(await page.locator('#matches-count').innerText(),/1 unknown/);assert.equal(await page.locator('#matches-pnl').innerText(),'+$0.00');
});

test('pausing a delayed quote cannot create a practice entry later',{timeout:15000},async t=>{
 const page=await open(t);await page.evaluate(()=>{const request=state.pub.request.bind(state.pub);state.pub.request=(q,...args)=>q.proposal?new Promise(resolve=>{window.__lateQuote=async()=>resolve(await request(q,...args));}):request(q,...args);});
 await page.locator('#matches-start').click();await page.waitForFunction(()=>typeof window.__lateQuote==='function');await page.locator('#matches-pause').click();
 await page.evaluate(()=>window.__lateQuote());await page.evaluate(()=>window.__tick());
 assert.equal(await page.evaluate(()=>matchesLab.engine.pending),null);assert.equal(await page.locator('#matches-start').innerText(),'Resume');
});

test('phone outcome animation stays inside the practice panel without horizontal page movement',{timeout:15000},async t=>{
 const page=await open(t,{mobile:true});await page.locator('#matches-start').click();await quoted(page);
 await page.evaluate(()=>{window.__tick();window.__tick(100.07);const el=document.getElementById('result-flash');for(const animation of el.getAnimations()){animation.pause();animation.currentTime=210;}});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=2);
 assert.equal(await page.locator('#matches-testing').evaluate(el=>getComputedStyle(el).position),'relative');
});
