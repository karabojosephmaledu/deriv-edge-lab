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
   send(raw){const q=JSON.parse(raw);window.__requests.push(q);if(!('ticks'in q||'forget_all'in q||'ping'in q||q.proposal===1&&q.contract_type==='DIGITMATCH'))throw new Error('Non-market command forbidden');const message=q.proposal?(window.__quoteInvalid?{error:{code:'MockUnavailable'}}:{proposal:{id:'public-quote-'+q.req_id,ask_price:q.amount,payout:Math.round(q.amount*8.33*100)/100},echo_req:q}):{};setTimeout(()=>this.onmessage?.({data:JSON.stringify({...message,req_id:q.req_id})}),0);}
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

test('account dashboard: genuine Demo/Real balances, selection and reload never send orders or re-login',{timeout:15000},async t=>{
 const page=await open(t);
 assert.match(await page.locator('#balance-value').innerText(),/10,000\.00/);
 assert.equal(await page.locator('#account-select option').count(),2);
 await page.locator('#account-select').selectOption('ROT-test');await page.waitForFunction(()=>state.view?.selected_account.id==='ROT-test'&&!state.checking);
 assert.match(await page.locator('#balance-value').innerText(),/2,500\.00/);assert.equal(await page.locator('#balance-currency').innerText(),'EUR');assert.match(await page.locator('#account-type').innerText(),/Real.*view only/i);
 await page.reload();await page.waitForFunction(()=>state.view?.selected_account.id==='ROT-test');
 assert.equal(model.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/session')).length,1);
 assert.equal(model.calls.some(c=>c.path.includes('/demo/')||c.path.endsWith('/account')),false);
 assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(localStorage)+JSON.stringify(sessionStorage)+document.cookie),/private-login-canary|old-private-token-canary|test-session/);
});

test('account dashboard: provider transactions change the genuine balance; research never funds it',{timeout:15000},async t=>{
 const page=await open(t);
 model.balances['DOT-test']=10009;
 model.transactions=[{id:'t2',time:1002,action:'sell',amount:109,balance_after:10009,description:'Digit contract',contract_id:'1'},{id:'t1',time:1000,action:'buy',amount:-100,balance_after:9900,description:'Digit contract',contract_id:'1'}];
 model.contracts=[{id:'c1',time:1002,stake:100,return:109,profit:9}];
 await page.evaluate(()=>refreshAccount());
 assert.match(await page.locator('#balance-value').innerText(),/10,009\.00/);assert.equal(await page.locator('#account-transactions tr').count(),2);
 assert.equal(await page.locator('.transaction-description').first().evaluate(el=>getComputedStyle(el).whiteSpace),'normal');
 assert.equal(await page.locator('#stat-wins').innerText(),'1');assert.match(await page.locator('#stat-pnl').innerText(),/9\.00/);
 await page.locator('#matches-research > summary').click();await page.waitForFunction(()=>document.getElementById('matches-metrics').children.length>0);
 assert.match(await page.locator('#balance-value').innerText(),/10,009\.00/);assert.equal(model.calls.some(c=>c.path.includes('/demo/')),false);
});

test('account dashboard: no wallet or other strategy controls, saved research remains separate',{timeout:15000},async t=>{
 const page=await open(t);
 assert.equal(await page.locator('#virtual-wallet,#execution-mode,[data-product],button[data-digit],#lab-card,#start-btn').count(),0);
 assert.equal(await page.locator('#matches-research').isVisible(),true);assert.equal(await page.locator('#matches-research').getAttribute('open'),null);
 await page.evaluate(()=>localStorage.setItem('del.virtual.session.v1',JSON.stringify({version:1,current:{stats:{wins:42,losses:2,net:102.44},wallet:{starting:1000},history:[{time:'2026-11-14T12:00:00Z',label:'Legacy observation',pnl:4.82,outcome:'win'}]},archives:[]})));
 await page.reload();await page.waitForFunction(()=>state.view);
 await page.locator('#saved-research > summary').click();
 assert.match(await page.locator('#saved-research-stats').innerText(),/42 wins.*2 losses.*102\.44.*Not a Deriv account result/);
 assert.match(await page.locator('#balance-value').innerText(),/10,000\.00/);
 assert.doesNotMatch(await page.locator('body').innerText(),/Starting virtual balance|Available virtual money|Starting balance for the next/);
});

test('account dashboard: genuine settlement alerts keep original tones and never replay',{timeout:15000},async t=>{
 const page=await open(t); // Login click unlocks sound in this controlled browser.
 model.contracts=[{id:'a',time:1001,stake:100,return:109,profit:9}];await page.evaluate(()=>refreshAccount());
 assert.deepEqual(await page.evaluate(()=>window.__notes),[880,1318.5]);assert.match(await page.locator('#result-flash').getAttribute('class'),/win/);
 await page.evaluate(()=>refreshAccount());assert.equal(await page.evaluate(()=>window.__notes.length),2);
 model.contracts.unshift({id:'b',time:1002,stake:100,return:0,profit:-100});await page.evaluate(()=>refreshAccount());
 assert.deepEqual(await page.evaluate(()=>window.__notes.slice(-2)),[220,164.8]);assert.match(await page.locator('#result-flash').getAttribute('class'),/loss/);
 await page.reload();await page.waitForFunction(()=>state.view);assert.deepEqual(await page.evaluate(()=>window.__notes),[]);
 await page.locator('#sound-toggle').click();assert.equal(await page.locator('#sound-toggle').innerText(),'Sound OFF');
 model.contracts.unshift({id:'c',time:1003,stake:100,return:109,profit:9});await page.evaluate(()=>refreshAccount());assert.deepEqual(await page.evaluate(()=>window.__notes),[]);
 await page.reload();assert.equal(await page.locator('#sound-toggle').innerText(),'Sound OFF');
});

test('account dashboard: refresh errors retain timestamped balances and never invent history',{timeout:15000},async t=>{
 const page=await open(t);model.balanceError='Balance refresh unavailable';model.historyError='History not authorized';await page.evaluate(()=>refreshAccount());
 assert.match(await page.locator('#balance-value').innerText(),/10,000\.00/);assert.match(await page.locator('#account-balance-status').innerText(),/unavailable.*last checked/);
 assert.match(await page.locator('#transaction-status').innerText(),/not authorized.*No verified/);assert.equal(await page.locator('#stat-pnl').innerText(),'—');
});

test('account dashboard: secure OAuth callback and mobile layout preserve original features',{timeout:15000},async t=>{
 const page=await open(t,{oauth:true,mobile:true});
 assert.equal(await page.evaluate(()=>redirectUri()),origin+'/api/deriv/callback');
 assert.equal(model.calls.some(c=>c.path.endsWith('/token')&&c.body.code==='synthetic-code'),true);
 assert.equal(await page.locator('#tick-trail .digit-cell').count(),10);assert.equal(await page.locator('#digit-frequency .freq-col').count(),10);
 const layout=await page.evaluate(()=>{const a=document.querySelector('.brand').getBoundingClientRect(),b=document.querySelector('.topbar-actions').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,overlap:b.top<a.bottom};});
 assert.ok(layout.overflow<=2);assert.equal(layout.overlap,false);
 await page.locator('#connect-button-nav').click();assert.equal(await page.locator('#connect-dialog').getAttribute('open'),null);
});

test('account dashboard: stalled account request ends checking while market feed stays independent',{timeout:15000},async t=>{
 const page=await open(t);
 await page.evaluate(()=>{const original=window.fetch;window.fetch=(url,options)=>String(url).includes('/account-display')?new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))):original(url,options);const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===55000?25:ms,...args);});
 await page.evaluate(()=>refreshAccount());assert.equal(await page.evaluate(()=>state.checking),false);
 assert.match(await page.locator('#account-auth-status').innerText(),/timed out.*Retry status/);assert.equal(await page.evaluate(()=>state.feed),'live');
});

test('account dashboard: expired authorization removes the verified balance and disconnect never leaves checking stuck',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#disconnect-button').click();await page.waitForFunction(()=>!state.view&&!state.checking);
 assert.equal(model.connected,false);assert.equal(await page.locator('#account-live').isVisible(),false);assert.equal(await page.evaluate(()=>state.auth),'unauthorised');
});

test('account dashboard: a delayed old account cannot overwrite a newer selection',{timeout:15000},async t=>{
 const page=await open(t);
 await page.evaluate(()=>{
   const original=window.fetch;
   window.fetch=async(url,options)=>{
     if(String(url).includes('account_id=DOT-test')){
       const response=await original(url,options);
       return new Promise(resolve=>{window.__lateAccount=()=>resolve(response);});
     }
     return original(url,options);
   };
   void refreshAccount('DOT-test');
 });
 await page.waitForFunction(()=>typeof window.__lateAccount==='function');
 await page.evaluate(()=>refreshAccount('ROT-test'));
 await page.evaluate(()=>window.__lateAccount());
 assert.equal(await page.evaluate(()=>state.view.selected_account.id),'ROT-test');
 assert.equal(await page.evaluate(()=>state.checking),false);
 assert.match(await page.locator('#balance-value').innerText(),/2,500\.00/);
});

test('account dashboard: disconnect invalidates in-flight status and blocks polling until completion',{timeout:15000},async t=>{
 const page=await open(t);
 await page.evaluate(()=>{
  const original=window.fetch;
  window.fetch=async(url,options)=>{
    if(String(url).includes('/account-display')){const response=await original(url,options);return new Promise(resolve=>{window.__lateLogout=()=>resolve(response);});}
    if(String(url).endsWith('/disconnect'))await new Promise(resolve=>{window.__finishLogout=resolve;});
    return original(url,options);
  };
  void refreshAccount();
 });
 await page.waitForFunction(()=>typeof window.__lateLogout==='function');
 await page.locator('#disconnect-button').click();
 await page.waitForFunction(()=>typeof window.__finishLogout==='function');
 assert.equal(await page.evaluate(()=>state.checking),true);
 await page.evaluate(()=>window.__finishLogout());
 await page.waitForFunction(()=>state.auth==='unauthorised'&&!state.checking);
 await page.evaluate(()=>window.__lateLogout());
 assert.equal(await page.evaluate(()=>state.view),null);
 assert.equal(await page.locator('#account-live').isVisible(),false);
});

async function quoted(page){await page.waitForFunction(()=>!!window.matchesLab?.quote);}
async function virtualOutcome(page,digit=7){await quoted(page);await page.evaluate(()=>window.__tick(100.01));await page.evaluate(d=>window.__tick(100+d/100),digit);}

test('virtual Matches: Start uses live quotes, exact next-tick matches and profit target; actual account untouched',{timeout:15000},async t=>{
 const page=await open(t);
 await page.locator('#matches-target').fill('7');await page.locator('#matches-start').click();
 await quoted(page);await page.evaluate(()=>window.__tick(100.01));
 assert.equal(await page.locator('#matches-wins').innerText(),'0');
 await page.evaluate(()=>window.__tick(100.07));
 assert.equal(await page.locator('#matches-wins').innerText(),'1');assert.equal(await page.locator('#matches-pnl').innerText(),'+$7.33');
 assert.match(await page.locator('#matches-status').innerText(),/profit target reached/);
 assert.match(await page.locator('#balance-value').innerText(),/10,000\.00/);assert.equal(await page.locator('#stat-pnl').innerText(),'+$0.00');
 assert.equal(model.calls.some(c=>c.path.includes('/demo/')),false);
 assert.deepEqual(await page.evaluate(()=>window.__notes.slice(-2)),[880,1318.5]);
});

test('virtual Matches: a pending loss while paused obeys total loss limit and cannot Resume',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-loss').fill('1');await page.locator('#matches-start').click();await quoted(page);
 await page.evaluate(()=>window.__tick());await page.locator('#matches-pause').click();await page.evaluate(()=>window.__tick());
 assert.equal(await page.locator('#matches-losses').innerText(),'1');assert.equal(await page.locator('#matches-pnl').innerText(),'−$1.00');
 assert.equal(await page.locator('#matches-start').innerText(),'New session');assert.match(await page.locator('#matches-status').innerText(),/loss limit reached/);
 assert.deepEqual(await page.evaluate(()=>window.__notes.slice(-2)),[220,164.8]);
 await page.locator('#matches-start').click();assert.equal(await page.locator('#matches-history tr').count(),0);
});

test('virtual Matches: Stop locks restart until pending settlement; paused quote requests never open positions',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#matches-start').click();await quoted(page);await page.evaluate(()=>window.__tick());
 await page.locator('#matches-stop').click();assert.equal(await page.locator('#matches-start').isDisabled(),true);
 await page.evaluate(()=>window.__tick());assert.equal(await page.locator('#matches-losses').innerText(),'1');
 await page.locator('#matches-start').click();await page.locator('#matches-pause').click();await page.evaluate(()=>window.__tick());
 assert.equal(await page.evaluate(()=>matchesLab.engine.pending),null);assert.equal(await page.locator('#matches-losses').innerText(),'0');
 assert.equal(await page.locator('#matches-start').innerText(),'Resume');
});

test('Video Growth: the $47 experiment steps from $1 to $2 at $100 and never raises stake after a loss',{timeout:20000},async t=>{
 const page=await open(t);await page.locator('#matches-preset').selectOption('growth');
 assert.match(await page.locator('#matches-stage').innerText(),/Stage 1\/4.*47\.00.*1\.00/);assert.equal(await page.locator('#matches-stake').isDisabled(),true);
 await page.locator('#matches-start').click();
 for(let i=0;i<8;i++)await virtualOutcome(page);
 assert.match(await page.locator('#matches-stage').innerText(),/Stage 2\/4.*105\.64.*2\.00/);
 await virtualOutcome(page,1);
 assert.match(await page.locator('#matches-stage').innerText(),/Stage 2\/4.*103\.64.*2\.00/);
 assert.match(await page.locator('#balance-value').innerText(),/10,000\.00/);
 assert.equal(await page.evaluate(()=>matchesLab.engine.history[0].ask),200);
 assert.equal(model.calls.some(c=>c.path.includes('/demo/')),false);
});

test('virtual Matches: refresh preserves settled results paused and marks an open result unknown once',{timeout:20000},async t=>{
 const page=await open(t);await page.locator('#matches-start').click();await virtualOutcome(page);await page.locator('#matches-pause').click();
 await page.reload();await page.waitForFunction(()=>state.feed==='live'||window.__socket?.readyState===1);await page.evaluate(()=>window.__tick());
 assert.equal(await page.locator('#matches-start').innerText(),'Resume');assert.equal(await page.locator('#matches-pnl').innerText(),'+$7.33');assert.deepEqual(await page.evaluate(()=>window.__notes),[]);
 await page.locator('#matches-start').click();await quoted(page);await page.evaluate(()=>window.__tick());await page.reload();
 assert.match(await page.locator('#matches-count').innerText(),/1 unresolved/);assert.equal(await page.locator('#matches-pnl').innerText(),'+$7.33');
 await page.reload();assert.match(await page.locator('#matches-count').innerText(),/1 unresolved/);assert.equal(await page.locator('#matches-history tr').count(),2);
});

test('virtual Matches: failed quotes and disconnected ticks produce no fabricated win',{timeout:15000},async t=>{
 const page=await open(t);await page.evaluate(()=>window.__quoteInvalid=true);await page.locator('#matches-start').click();
 await page.waitForFunction(()=>matchesLab.engine.status==='done');assert.equal(await page.locator('#matches-wins').innerText(),'0');assert.equal(await page.locator('#matches-history tr').count(),0);
 await page.evaluate(()=>window.__quoteInvalid=false);await page.locator('#matches-start').click();await quoted(page);await page.evaluate(()=>{window.__tick();window.__socket.close();});
 assert.match(await page.locator('#matches-count').innerText(),/1 unresolved/);assert.equal(await page.locator('#matches-wins').innerText(),'0');
});

test('virtual Matches: mobile controls, stage, chart and account switching stay usable without wallet clutter',{timeout:15000},async t=>{
 const page=await open(t,{mobile:true});await page.locator('#matches-preset').selectOption('growth');
 for(const id of ['matches-start','matches-pause','matches-stop'])assert.equal(await page.locator('#'+id).isVisible(),true);
 await page.locator('#account-select').selectOption('ROT-test');await page.waitForFunction(()=>state.view?.selected_account.id==='ROT-test');
 await page.locator('#matches-start').click();await virtualOutcome(page,1);await page.locator('#matches-stop').click();
 assert.match(await page.locator('#balance-value').innerText(),/2,500\.00/);assert.equal(await page.locator('#matches-pnl').innerText(),'−$1.00');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=2);
 assert.equal(await page.locator('#virtual-wallet').count(),0);
});

test('virtual Matches: refreshing a different market restores that market and paused controls correctly',{timeout:15000},async t=>{
 const page=await open(t);await page.locator('#symbol-select').selectOption('R_25');
 await page.evaluate(()=>window.__tick());await page.locator('#matches-start').click();await virtualOutcome(page,1);await page.locator('#matches-pause').click();
 await page.reload();await page.waitForFunction(()=>window.__requests.some(q=>q.ticks==='R_25'));await page.evaluate(()=>window.__tick());
 assert.equal(await page.locator('#symbol-select').inputValue(),'R_25');assert.equal(await page.locator('#matches-start').innerText(),'Resume');assert.equal(await page.locator('#symbol-select').isDisabled(),true);
 await page.locator('#matches-start').click();await virtualOutcome(page,7);assert.equal(await page.locator('#matches-wins').innerText(),'1');assert.equal(await page.locator('#matches-losses').innerText(),'1');
});

test('virtual Matches: cancelling an in-flight quote cannot leave a Requesting message or open a paused entry',{timeout:15000},async t=>{
 const page=await open(t);
 await page.evaluate(()=>{const request=state.pub.request.bind(state.pub);state.pub.request=(q,...args)=>q.proposal?new Promise(resolve=>{window.__delayedQuote=async()=>resolve(await request(q,...args));}):request(q,...args);});
 await page.locator('#matches-start').click();await page.waitForFunction(()=>typeof window.__delayedQuote==='function');await page.locator('#matches-pause').click();
 assert.doesNotMatch(await page.locator('#matches-quote').innerText(),/Requesting/);
 await page.evaluate(()=>window.__delayedQuote());await page.evaluate(()=>window.__tick());
 assert.equal(await page.evaluate(()=>matchesLab.engine.pending),null);assert.equal(await page.locator('#matches-start').innerText(),'Resume');
});
