/* Simple automatic practice controller. Never submits account orders. */
(function () {
  'use strict';
  const M=MatchesSimulation, KEY='del.matches.auto.v1';
  let engine=null, quote=null, quoting=false, generation=0, uiError=null, lastPrice=null, available=true;
  let observations=new Map(), precision=null, historyGeneration=0, historyPending=false, historyAttempted=false;
  const active=()=>engine&&(['running','paused','stopping'].includes(engine.status)||!!engine.pending);
  const ready=()=>state.feed==='live'&&state.pub?.isOpen()&&state.lastEpoch>0&&Date.now()-state.lastTickAt<5000;
  const interval=()=>$('symbol-select').value.startsWith('1HZ')?1:2;
  const rows=()=>[...observations.values()].sort((a,b)=>a.epoch-b.epoch);
  const signal=()=>M.signal(rows(),state.lastEpoch,interval());
  function config(){return{preset:'fixed',auto:true,digit:0,stake:$('matches-stake').value,target:$('matches-target').value,loss:$('matches-loss').value,symbol:$('symbol-select').value};}
  function cancelQuote(){generation++;quote=null;quoting=false;}
  function save(){if(engine)try{localStorage.setItem(KEY,JSON.stringify({version:1,current:engine.snapshot()}));}catch{uiError='Browser storage is unavailable; this practice session may not survive refresh.';}}
  function shortReason(){
    if(!engine)return ready()?'Ready. Press Start.':'Waiting for live prices.';
    if(engine.status==='paused')return 'Paused.';
    if(engine.status==='stopping')return 'Stopping — waiting for the open result.';
    if(engine.status==='running'){
      if(engine.pending)return 'Running — waiting for the next tick.';
      if(quoting)return 'Running — checking the price.';
      if(!signal())return observations.size<200?'Preparing automatic selection ('+Math.min(observations.size,200)+'/200).':'Waiting for a clear digit.';
      return 'Running — digit selected automatically.';
    }
    if(engine.reason.includes('profit target'))return 'Target reached.';
    if(engine.reason.toLowerCase().includes('loss limit'))return 'Stopped — the loss limit prevents another entry.';
    if(engine.unknown)return 'Stopped — price data was interrupted; a result is unknown.';
    return engine.reason.startsWith('Price unavailable')?'Stopped — no current price. Press Start to retry.':'Stopped.';
  }
  function render(){
    const e=engine,locked=!!active();
    for(const id of ['matches-stake','matches-target','matches-loss'])$(id).disabled=locked||!available;
    if(available)$('symbol-select').disabled=locked;
    $('matches-start').disabled=!!(!available||e?.status==='running'||e?.status==='stopping'||e?.pending&&e.status!=='paused'||!ready());
    $('matches-start').textContent=e?.status==='paused'?'Resume':e?.status==='done'?'New session':'Start';
    $('matches-pause').disabled=!available||e?.status!=='running';$('matches-stop').disabled=!available||!locked;
    $('matches-status').textContent=uiError||shortReason();
    const digit=e?.pending?.digit??quote?.digit??(e?.status==='running'?signal()?.digit:null);
    $('matches-auto-digit').textContent=digit==null?'Digit selection: automatic':'Automatic digit: '+digit;
    $('matches-quote').textContent=lastPrice?'Practice return if matched: '+signed((lastPrice.gross-lastPrice.ask)/100,'USD')+' · if missed: −'+money(lastPrice.ask/100,'USD'):'A current Deriv price is required before each entry.';
    $('matches-wins').textContent=e?.wins||0;$('matches-losses').textContent=e?.losses||0;
    $('matches-rate').textContent=e?.trades?(100*e.wins/e.trades).toFixed(1)+'%':'—';
    $('matches-pnl').textContent=e?signed(e.net/100,'USD'):money(0,'USD');$('matches-pnl').className='tile-value '+(e?.net>0?'win':e?.net<0?'loss':'');
    const last=e?.history[0];
    $('matches-count').textContent=(e?.trades||0)+' completed practice entries'+(e?.unknown?' · '+e.unknown+' unknown (P/L incomplete)':'')+(last?' · Last result: '+last.outcome+(last.profit==null?'':' ('+signed(last.profit/100,'USD')+')'):'')+'.';
  }
  function observe(t){
    const digit=Number(t.price.toFixed(t.pip).slice(-1));
    if(precision!==null&&precision!==t.pip){cancelQuote();observations.clear();historyGeneration++;historyPending=false;historyAttempted=false;}
    precision=t.pip;observations.set(t.epoch,{epoch:t.epoch,digit});
    if(observations.size>500)observations=new Map(rows().slice(-400).map(r=>[r.epoch,r]));
  }
  async function ensureHistory(){
    if(historyAttempted||historyPending||!ready()||precision===null)return;
    historyAttempted=true;historyPending=true;
    const gen=historyGeneration,symbol=$('symbol-select').value,pip=precision;
    try{
      const response=await state.pub.request({ticks_history:symbol,count:200,end:'latest',style:'ticks',adjust_start_time:1},10000);
      if(gen!==historyGeneration||symbol!==$('symbol-select').value)return;
      const prices=response.history?.prices,times=response.history?.times;
      if(!Array.isArray(prices)||!Array.isArray(times)||prices.length!==times.length||prices.length!==200||!['number','string'].includes(typeof response.pip_size)||response.pip_size===''||Number(response.pip_size)!==pip||response.echo_req&&response.echo_req.ticks_history!==symbol)throw Error('Invalid public history');
      const imported=[];
      for(let i=0;i<prices.length;i++){
        if(![prices[i],times[i]].every(v=>typeof v==='number'||typeof v==='string'&&v.trim()!==''))throw Error('Invalid public history');
        const price=Number(prices[i]),epoch=Number(times[i]);
        if(!Number.isFinite(price)||price<=0||!Number.isSafeInteger(epoch)||epoch<=0||i>0&&epoch-Number(times[i-1])!==interval())throw Error('Invalid public history');
        const digit=Number(price.toFixed(pip).slice(-1));
        if(observations.has(epoch)&&observations.get(epoch).digit!==digit)throw Error('Conflicting public observations');
        imported.push({epoch,digit});
      }
      for(const row of imported)if(!observations.has(row.epoch))observations.set(row.epoch,row);
    }catch{/* Build from observed live ticks if the public history is unavailable. No synthetic data. */}
    finally{if(gen===historyGeneration){historyPending=false;render();if(engine?.status==='running')void fetchQuote();}}
  }
  async function fetchQuote(){
    if(!engine||engine.status!=='running'||engine.pending||quoting||!ready())return;
    const chosen=signal();if(!chosen){void ensureHistory();return;}
    const e=engine,gen=generation,stake=e.cfg.stake;quoting=true;render();
    try{
      const response=await state.pub.request({proposal:1,amount:stake,basis:'stake',contract_type:'DIGITMATCH',currency:'USD',duration:1,duration_unit:'t',underlying_symbol:e.cfg.symbol,barrier:String(chosen.digit)},10000);
      if(gen!==generation||engine!==e||e.status!=='running')return;
      quote={...M.quote(response,stake,e.cfg.symbol,chosen.digit,Date.now()),signalEpoch:chosen.epoch};lastPrice=quote;
    }catch{if(gen===generation&&engine===e){engine.interrupt('Price unavailable');quote=null;save();}}
    finally{if(gen===generation){quoting=false;render();}}
  }
  function feed(t){
    if(!available)return;
    observe(t);void ensureHistory();
    if(!engine){render();return;}
    const event=engine.feed(t,quote);
    if(event?.type==='opened'){quote=null;save();}
    if(event?.type==='settled'){
      const row=event.row,win=row.profit>0,el=$('result-flash');el.className='result-flash '+(win?'win':'loss');el.textContent=(win?'WIN ':'LOSS ')+signed(row.profit/100,'USD')+' · practice';el.hidden=false;
      $('result-announcer').textContent=el.textContent;clearTimeout(flashTimer);flashTimer=setTimeout(()=>{el.hidden=true;},1200);playResultSound(win);quote=null;save();
    }
    if(event?.type==='interrupted'){cancelQuote();save();}
    render();if(engine.status==='running'&&!engine.pending&&(!quote||Date.now()-quote.received>10000))void fetchQuote();
  }
  function interrupt(reason){
    historyGeneration++;historyPending=false;historyAttempted=false;observations.clear();precision=null;
    cancelQuote();
    if(engine&&active()&&!(engine.status==='paused'&&!engine.pending)){engine.interrupt(reason);save();}
    render();
  }
  function start(){
    unlockAudio();if(!available||!ready())return;uiError=null;
    try{
      if(!engine||engine.status==='done'||engine.status==='idle'){engine=new M.Engine(config());engine.lastEpoch=state.lastEpoch;lastPrice=null;}
      engine.start();cancelQuote();render();save();
      if(!signal()&&!historyPending)historyAttempted=false;
      void ensureHistory();void fetchQuote();
    }catch(error){uiError=error.message;render();}
  }
  try{
    const data=JSON.parse(localStorage.getItem(KEY)||'null');
    if(data?.version===1&&data.current?.cfg.auto===true){engine=M.Engine.restore(data.current);const changed=$('symbol-select').value!==engine.cfg.symbol;$('symbol-select').value=engine.cfg.symbol;if(changed&&state.pub?.isOpen())void subscribeMarket();$('matches-stake').value=engine.cfg.stake;$('matches-target').value=engine.cfg.target??'';$('matches-loss').value=engine.cfg.loss??'';save();}
  }catch{engine=null;}
  for(const id of ['matches-stake','matches-target','matches-loss'])$(id).addEventListener('change',()=>{if(active())return;uiError=null;cancelQuote();lastPrice=null;render();});
  $('matches-start').addEventListener('click',start);
  $('matches-pause').addEventListener('click',()=>{if(engine){engine.pause();cancelQuote();save();render();}});
  $('matches-stop').addEventListener('click',()=>{if(engine){engine.stop();cancelQuote();save();render();}});
  window.matchesLab={feed,interrupt,render,setAvailable(value){available=Boolean(value);if(!available)interrupt('Practice stopped while genuine account controls are selected');render();},get engine(){return engine;},get quote(){return quote;}};
  render();
  setInterval(()=>{if(active()&&state.lastTickAt&&Date.now()-state.lastTickAt>10000)interrupt('No fresh live ticks · open result unresolved');else render();},1000);
})();
