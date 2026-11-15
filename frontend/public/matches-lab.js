/* Small virtual-only controller. Account displays, authentication and execution are independent. */
(function () {
  'use strict';
  const M=MatchesSimulation, KEY='del.matches.sessions.v1';
  let lastQuoteLabel=null, uiError=null, preview=false, engine=null, quote=null, quoting=false, generation=0, archives=[], quoteLabel='Payout requires a current public Deriv Matches quote. No substitute payout is used.';
  const active=()=>engine&&(['running','paused','stopping'].includes(engine.status)||!!engine.pending);
  const ready=()=>state.feed==='live'&&state.pub?.isOpen()&&state.lastEpoch>0&&Date.now()-state.lastTickAt<5000;
  function config(){return{preset:$('matches-preset').value,digit:Number($('matches-digit').value),stake:$('matches-stake').value,target:$('matches-target').value,loss:$('matches-loss').value,symbol:$('symbol-select').value};}
  function cancelQuote(){generation++;quote=null;if(quoting)quoteLabel=lastQuoteLabel?lastQuoteLabel.replace("Public quote", "Last public quote (reference)"):"Quote request cancelled. Start or Resume for a fresh quote.";quoting=false;}
  function save(){if(!engine)return;try{localStorage.setItem(KEY,JSON.stringify({version:1,current:engine.snapshot(),archives:archives.slice(0,20)}));}catch{$('matches-status').textContent+=' Browser storage unavailable; refresh may lose this virtual session.';}}
  function render(){
    const e=engine, running=e?.status==='running', locked=active(), growth=(e&&!preview?e.cfg.preset:$('matches-preset').value)==='growth';
    for(const id of ['matches-preset','matches-digit','matches-target','matches-loss'])$(id).disabled=!!locked;
    $('matches-stake').disabled=!!locked||growth;
    $('symbol-select').disabled=!!locked;
    $('matches-start').disabled=!!(running||e?.status==='stopping'||e?.pending&&e.status!=='paused'||!ready());
    $('matches-start').textContent=e?.status==='paused'?'Resume':e?.status==='done'?'New session':'Start';
    $('matches-pause').disabled=!running; $('matches-stop').disabled=!locked;
    $('matches-status').textContent=uiError||(e?e.reason:ready()?'Ready · virtual testing only':'Waiting for verified live Deriv ticks.');
    const st=e&&!preview?e.stage():{stake:growth?1:Number($('matches-stake').value),index:0,level:growth?47:null,to:100};
    $('matches-stage').textContent=growth?'Stage '+(st.index+1)+'/4 · virtual experiment level '+money(st.level,'USD')+' → '+money(st.to,'USD')+' · virtual stake '+money(st.stake,'USD'):'Fixed stake · '+money(st.stake,'USD')+' per virtual entry';
    $('matches-preset-note').textContent=growth?'Video example: $47–$100 at $1; $100–$200 at $2; $200–$500 at $5; $500–$1,000 at $10. Starts at a hypothetical $47. Stakes step down again if the virtual level falls. These milestones are not promised returns.':'Same selected digit and stake throughout the session. No Martingale or loss-based stake increases.';
    $('matches-quote').textContent=quoteLabel;
    $('matches-wins').textContent=e?.wins||0; $('matches-losses').textContent=e?.losses||0;
    $('matches-rate').textContent=e?.trades?(100*e.wins/e.trades).toFixed(1)+'%':'—';
    $('matches-pnl').textContent=e?signed(e.net/100,'USD'):money(0,'USD');
    $('matches-pnl').className='tile-value '+(e?.net>0?'win':e?.net<0?'loss':'');
    $('matches-count').textContent=(e?.trades||0)+' settled virtual outcomes'+(e?.unknown?' · '+e.unknown+' unresolved (P/L incomplete)':'')+(e?.pending?' · one open virtual entry; waiting for the next live tick':'')+'.';
    const body=$('matches-history');body.textContent='';
    for(const row of e?.history||[]){const tr=document.createElement('tr');tr.append(cell(row.n+' · '+new Date(row.time).toLocaleTimeString()),cell('Match '+row.digit+' → '+(row.exitDigit??'?')+' · '+row.outcome),cell(money(row.ask/100,'USD')),cell(row.profit==null?'Unknown':signed(row.profit/100,'USD')));body.append(tr);}
  }
  async function fetchQuote(){
    if(!engine||engine.status!=='running'||engine.pending||quoting||!ready())return;
    const e=engine, st=e.stage().stake, gen=generation;quoting=true;
    quoteLabel='Requesting a public Digit Matches quote…';render();
    try{
      const response=await state.pub.request({proposal:1,amount:st,basis:'stake',contract_type:'DIGITMATCH',currency:'USD',duration:1,duration_unit:'t',underlying_symbol:e.cfg.symbol,barrier:String(e.cfg.digit)},10000);
      if(gen!==generation||engine!==e||e.status!=='running'||e.stage().stake!==st)return;
      quote=M.quote(response,st,e.cfg.symbol,e.cfg.digit,Date.now());
      const profit=(quote.gross-quote.ask)/100;
      quoteLabel='Public quote · stake '+money(quote.ask/100,'USD')+' · gross return if matched '+money(quote.gross/100,'USD')+' · profit if matched '+signed(profit,'USD')+' · loss if not matched −'+money(st,'USD')+' · break-even '+(100*quote.ask/quote.gross).toFixed(2)+'% wins.';lastQuoteLabel=quoteLabel;
    }catch(error){if(gen===generation&&engine===e){e.interrupt('Quote unavailable or invalid · no new virtual entry. Press New session to retry.');quoteLabel=error?.message||'Deriv did not provide a valid public Matches payout.';quote=null;save();}}
    finally{if(gen===generation){quoting=false;render();}}
  }
  function feed(t){
    if(!engine)return;
    const event=engine.feed(t,quote);
    if(event?.type==='opened'){quote=null;save();}
    if(event?.type==='settled'){
      const row=event.row,win=row.profit>0,el=$('result-flash');
      el.className='result-flash '+(win?'win':'loss');el.textContent=(win?'WIN ':'LOSS ')+signed(row.profit/100,'USD')+' · virtual Digit Matches';el.hidden=false;
      $('result-announcer').textContent=el.textContent;clearTimeout(flashTimer);flashTimer=setTimeout(()=>{el.hidden=true;},1200);playResultSound(win);quote=null;save();
    }
    if(event?.type==='interrupted'){cancelQuote();save();}
    render();
    if(engine.status==='running'&&!engine.pending&&(!quote||Date.now()-quote.received>10000))void fetchQuote();
  }
  function interrupt(reason){if(!engine||!active()||engine.status==='paused'&&!engine.pending)return;cancelQuote();engine.interrupt(reason);render();save();}
  function start(){
    unlockAudio();if(!ready())return;uiError=null;
    try{
      if(!engine||engine.status==='done'||engine.status==='idle'){
        const next=new M.Engine(config()); // Validate before archiving the old session.
        if(engine?.history.length)archives=[engine.snapshot(),...archives].slice(0,20);
        engine=next;engine.lastEpoch=state.lastEpoch;preview=false;
      }
      engine.start();cancelQuote();render();save();void fetchQuote();
    }catch(error){uiError=error.message;render();}
  }
  function load(){
    try{
      const data=JSON.parse(localStorage.getItem(KEY)||'null');
      if(data?.version===1){engine=M.Engine.restore(data.current);archives=(Array.isArray(data.archives)?data.archives:[]).slice(0,20).filter(s=>{try{M.Engine.restore(s);return true;}catch{return false;}});}
    }catch{engine=null;}
    if(engine){const changed=$('symbol-select').value!==engine.cfg.symbol;$('symbol-select').value=engine.cfg.symbol;if(changed&&state.pub?.isOpen())void subscribeMarket();$('matches-preset').value=engine.cfg.preset;$('matches-digit').value=engine.cfg.digit;$('matches-stake').value=engine.cfg.stake;$('matches-target').value=engine.cfg.target??'';$('matches-loss').value=engine.cfg.loss??'';save();}
    for(const s of archives){state.saved.push({stats:{wins:s.wins,losses:s.losses,net:s.net/100,maxDD:s.maxDD/100},history:s.history.map(r=>({time:new Date(r.time).toISOString(),label:'Digit Matches · '+s.cfg.preset,pnl:r.profit==null?null:r.profit/100,outcome:r.outcome}))});const i=state.saved.length-1;$('saved-session-select').add(new Option('Matches archive · '+(s.wins+s.losses)+' virtual outcomes',String(i)));}
    if(state.saved.length)$('saved-session-select').disabled=false;
  }
  for(let d=0;d<10;d++)$('matches-digit').add(new Option(String(d),String(d)));$('matches-digit').value='7';
  for(const id of ['matches-preset','matches-digit','matches-stake','matches-target','matches-loss'])$(id).addEventListener('change',()=>{if(active())return;uiError=null;cancelQuote();preview=true;quoteLabel='Payout requires a current public Deriv Matches quote. No substitute payout is used.';render();});
  $('matches-start').addEventListener('click',start);
  $('matches-pause').addEventListener('click',()=>{if(!engine)return;engine.pause();cancelQuote();render();save();});
  $('matches-stop').addEventListener('click',()=>{if(!engine)return;engine.stop();cancelQuote();render();save();});
  window.matchesLab={feed,interrupt,render,get engine(){return engine;},get quote(){return quote;}};
  load();render();
  setInterval(()=>{if(active()&&state.lastTickAt&&Date.now()-state.lastTickAt>10000)interrupt("No fresh live ticks · open virtual result unresolved; session stopped");else render();},1000);
})();
