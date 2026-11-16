/* Original-strategy automatic controls. Credentials remain in the existing
 * server account session. Nothing runs until Start; Live also needs its server
 * flag and explicit selection. This script never sends Deriv socket orders. */
"use strict";
(() => {
  let cfg=null,run=null,busy=false,polling=false,historyView="account",lastStatusAt=0,pollError=null,statusGeneration=0;
  let knownRun=null,seenResults=new Set(),resultTimer;
  let marketRows=[],marketsReady=false,marketError=null,selectedSymbols=new Set();
  const el=id=>document.getElementById(id);
  const text=(id,value)=>{const node=el(id);if(node){node.textContent=value;if(id==="chart-error")node.hidden=!value;}};
  async function request(path,method="GET",body) {
    const response=await fetch("/api/deriv/chart/"+path,{method,credentials:"same-origin",cache:"no-store",
      headers:method==="GET"?{}:{"Content-Type":"application/json","X-Deriv-CSRF":state.csrf || ""},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    const data=await response.json();
    if(!response.ok)throw new Error(typeof data.detail==="string"?data.detail:"This session request could not be verified.");
    return data;
  }
  const money=(v,currency="USD")=>new Intl.NumberFormat("en-US",{style:"currency",currency}).format(v);
  const when=v=>v?new Date(v*1000).toLocaleTimeString():"—";
  const profit=(v,currency="USD")=>v==null?"—":(v>0?"+":"")+money(v,currency);
  const rememberMarkets=()=>{if(typeof ssSet==="function")ssSet("del.chart.markets",[...selectedSymbols]);};
  async function loadMarkets() {
    try {
      const data=await request("markets");if(!Array.isArray(data.markets))throw new Error("Market discovery returned no verified list.");
      marketRows=data.markets;marketsReady=true;marketError=null;
      const options=el("chart-market-options");options.textContent="";
      for(const row of marketRows) {
        const label=document.createElement("label");label.className="hint";
        const input=document.createElement("input");input.type="checkbox";input.value=row.symbol;input.dataset.market="true";
        input.checked=selectedSymbols.has(row.symbol) && row.supported;input.disabled=!row.supported;
        const name=document.createTextNode(" "+row.name+(row.supported?(row.open?"":" · closed"):" · unavailable for Multipliers"));label.append(input,name);options.append(label);
        if(!row.supported)selectedSymbols.delete(row.symbol);
        input.addEventListener("change",()=>{input.checked?selectedSymbols.add(row.symbol):selectedSymbols.delete(row.symbol);rememberMarkets();render();});
        if(row.supported && ![...el("symbol-select").options].some(o=>o.value===row.symbol))el("symbol-select").add(new Option(row.name,row.symbol));
      }
      selectedSymbols=new Set([...selectedSymbols].filter(symbol=>marketRows.some(m=>m.symbol===symbol && m.supported)));
    }catch(error){marketError=error.message;marketsReady=false;}
    render();
  }
  function receive(next) {
    if(pollError)text("chart-error","");
    run=next;lastStatusAt=Date.now();pollError=null;
    if(!next || knownRun!==next.id){if(knownRun!==next?.id)historyView=next?"session":"account";knownRun=next?.id;seenResults=new Set((next?.history || []).map(r=>r.id));return;}
    for(const row of [...(next.history || [])].reverse()) {
      if(seenResults.has(row.id))continue;seenResults.add(row.id);
      if(!Number.isFinite(row.profit) || row.profit===0)continue;
      if(typeof playResultSound==="function")playResultSound(row.profit>0);
      const flash=el("result-flash");flash.className="result-flash "+(row.profit>0?"win":"loss");
      flash.textContent=(row.profit>0?"WIN ":"LOSS ")+profit(row.profit)+" · actual Deriv settlement";flash.hidden=false;
      text("result-announcer",flash.textContent);clearTimeout(resultTimer);resultTimer=setTimeout(()=>{flash.hidden=true;},1200);
    }
  }
  function history() {
    const account=state.view?.selected_account,source=state.view;
    const current=run?.account_id===account?.id?run:null;
    const rows=(historyView==="account"?source?.contracts:current?.history) || [];
    const currency=historyView==="account"?account?.currency || "USD":"USD";
    const body=el("chart-history");body.textContent="";
    for(const row of rows.slice(0,20)) {
      const tr=document.createElement("tr");
      const result=row.profit>0?"WIN":row.profit<0?"LOSS":"BREAK-EVEN";
      for(const value of [when(row.closed_at || row.time),row.symbol || "—",String(row.contract_id || row.id),money(row.stake,currency),profit(row.profit,currency),result]) {
        const td=document.createElement("td");td.textContent=value;tr.append(td);
      }
      body.append(tr);
    }
    if(!rows.length) {
      const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=6;
      td.textContent=historyView==="session"?"No settled bot trades in this session. Analysing or waiting does not place a trade.":!account?"Connect an account to view its genuine trade history.":!source.contracts_updated_at?"Deriv trade history has not been verified yet.":"Deriv returned no recent settled contracts for this account.";
      tr.append(td);body.append(tr);
    }
    text("chart-history-note",historyView==="session"?"This bot session only · provider-confirmed settlements. Session P/L above belongs to this session.":
      (source?.contracts_error?source.contracts_error+" ":"")+"Selected account's genuine Deriv history · includes trades placed elsewhere · last verified "+when(source?.contracts_updated_at)+". This does not change bot session P/L.");
    for(const choice of ["session","account"])el("chart-history-"+choice).setAttribute("aria-pressed",String(choice===historyView));
  }
  function render() {
    if(!cfg?.enabled || !el("chart-testing"))return;
    const account=state.view?.selected_account;
    const active=run && (run.status==="running" || run.status==="paused" || run.pending);
    if(active && Array.isArray(run.symbols))selectedSymbols=new Set(run.symbols);
    if(run && account && run.account_id!==account.id && !active){run=null;knownRun=null;seenResults.clear();}
    const real=account?.type==="real";
    const enabled=Boolean(account && cfg[account.type+"_enabled"] && state.auth==="authorised");
    el("chart-live-choice").hidden=!real;
    el("chart-start").disabled=busy || active || !lastStatusAt || !!pollError || !marketsReady || !selectedSymbols.size || !enabled || !cfg.node_available || !cfg.worker_available || real && !el("chart-live-confirm").checked;
    el("chart-start").textContent=real?"Start Live trading":"Start Demo trading";
    el("chart-pause").disabled=busy || !run || !["running","paused"].includes(run.status);
    el("chart-pause").textContent=run?.status==="paused"?"Resume":"Pause";
    el("chart-stop").disabled=busy || !run || !["running","paused"].includes(run.status);
    for(const id of ["chart-stake","chart-target","chart-loss","chart-live-confirm","symbol-select","account-select"])el(id).disabled=Boolean(active || busy);
    for(const input of document.querySelectorAll('[data-market="true"]')){input.checked=selectedSymbols.has(input.value);input.disabled=Boolean(active || busy || !marketRows.find(m=>m.symbol===input.value)?.supported);}
    el("chart-select-open").disabled=Boolean(active || busy);el("chart-clear-markets").disabled=Boolean(active || busy);
    text("chart-market-summary","Markets to scan · "+selectedSymbols.size+" selected");
    const current=marketRows.find(m=>m.symbol===run?.symbol);
    text("chart-current-market",marketError || (run?"Current market: "+(current?.name || run.symbol):marketsReady?"Select the markets above; the bot checks only your selection.":"Loading verified Deriv markets…"));
    const statuses=el("chart-market-results");statuses.textContent="";
    for(const market of run?.markets || []){const item=document.createElement("li");item.textContent=(market.name || market.symbol)+" · "+market.verdict+" · "+market.note;statuses.append(item);}
    if(active && run.symbol && el("symbol-select").value!==run.symbol && [...el("symbol-select").options].some(o=>o.value===run.symbol)) {
      el("symbol-select").value=run.symbol;if(typeof subscribeMarket==="function")void subscribeMarket();
    }
    text("chart-mode",run && active ? (run.mode==="real"?"LIVE money":"Genuine Demo contracts") : real?"Live account selected":"Demo account selected");
    text("chart-status",run?.error || run?.note || (!account?"Connect your Deriv account first.":!enabled?"Automatic execution is disabled for this account type.":!cfg.worker_available?"The backend scanner is missing. Complete the backend deployment first.":!cfg.node_available?"The local scanner requires Node 24.":"Ready. Local rules check selected markets without AI credits."));
    const stale=!!pollError || !!run && Date.now()-lastStatusAt>15000;
    const headline=stale?"STATUS UNAVAILABLE — last known state only":!run?"READY — no session started":run.error && run.pending?"CONTRACT NEEDS RECOVERY — new entries stopped":run.error?"STOPPED — action needed":run.pending?.contract_id?
      (run.status==="running"?"CONTRACT OPEN — Deriv acknowledged":run.status.toUpperCase()+" ENTRIES — monitoring contract"):
      run.status==="paused"?"PAUSED — no new entries":run.status==="stopped"?"STOPPED — no new entries":run.phase==="analysing"?"RUNNING — checking local chart rules":run.phase==="loading_candles"?"RUNNING — loading market data":run.phase==="ordering"?"ACKNOWLEDGEMENT PENDING — not yet confirmed":run.phase==="quoting"?"RUNNING — checking Deriv quote":"RUNNING — waiting for a valid setup";
    text("chart-session-state",headline);
    text("chart-check-times",(run?.phase==="analysing" && run.status==="running"?"Analysing for "+Math.max(0,Math.floor(Date.now()/1000-run.phase_at))+"s · ":"")+"Last analysis: "+when(run?.last_check_at)+" · Next check: "+when(run?.next_check_at)+" · Server status: "+(lastStatusAt?new Date(lastStatusAt).toLocaleTimeString():"checking…"));
    if(pollError)text("chart-error","Cannot refresh bot status. Its last known state may still be active. "+pollError);
    text("chart-wins",String(run?.wins || 0));text("chart-losses",String(run?.losses || 0));
    text("chart-rate",run?.settled?(100*run.win_rate).toFixed(1)+"%":"—");text("chart-pnl",money(run?.net || 0));
    el("chart-pnl").className="tile-value "+((run?.net || 0)>0?"win":(run?.net || 0)<0?"loss":"");
    text("chart-contract",run?.pending?"Deriv contract "+(run.pending.contract_id || "acknowledgement pending")+" · "+run.pending.status+(run.pending.profit==null?"":" · unsettled P/L "+profit(run.pending.profit)):"No open automatic contract.");
    history();
    const market=el("connection-status");if(market)market.title="Market data connection only; bot activity is shown under the Start/Pause/Stop controls.";
    text("mode-badge","Local chart rules · "+(active?(run.mode==="real"?"Live":"Demo"):"automatic"));
    text("account-mode-note",cfg.real_enabled?"Genuine account display · trading starts only below":"Genuine account display · Live execution disabled");
  }
  async function action(name) {
    if(busy)return;statusGeneration++;busy=true;render();
    try {
      if(name==="start") {
        const a=state.view?.selected_account;
        if(!a || state.auth!=="authorised")throw new Error("Connect an authorized account first.");
        const symbols=[...selectedSymbols];if(!symbols.length)throw new Error("Select at least one supported market.");
        receive(await request("start","POST",{account_id:a.id,mode:a.type,symbol:symbols[0],symbols,
          stake:Number(el("chart-stake").value),target:Number(el("chart-target").value),max_loss:Number(el("chart-loss").value),
          acknowledge_live:a.type==="real" && el("chart-live-confirm").checked}));
        historyView="session";
      } else if(name==="recover") {
        receive(await request("recover","POST",{account_id:state.view?.selected_account?.id}));
      } else if(run)receive(await request("control","POST",{run_id:run.id,action:name==="pause" && run.status==="paused"?"resume":name}));
    } catch(e) {text("chart-error",e.message);}
    finally {busy=false;render();}
  }
  async function poll() {
    if(polling || busy || !state.csrf || state.auth!=="authorised"){render();return;}
    polling=true;
    const generation=statusGeneration;
    try {const data=await request("status");if(generation===statusGeneration && !busy)receive(data.run);}
    catch(e){if(generation===statusGeneration && !busy)pollError=e.message;}
    finally{polling=false;render();}
  }
  async function init() {
    const practice=el("matches-testing");practice.hidden=true;
    window.matchesLab?.setAvailable?.(false);
    text("mode-badge","Checking Demo controls");
    const availability=document.createElement("section");availability.className="card";availability.id="chart-availability";
    availability.innerHTML='<div class="card-kicker">Deriv Demo controls</div><p class="hint" id="chart-availability-status" role="status">Checking genuine Demo trading controls… Practice entries are suspended.</p><button class="btn btn-outline btn-sm" id="chart-retry" type="button" hidden>Retry Demo controls</button>';
    practice.after(availability);
    let retrying=false,retryTimer=null,retryDelay=2000;
    async function load(){
      if(retrying)return;
      retrying=true;clearTimeout(retryTimer);el("chart-retry").disabled=true;
      let next;
      try{
        next=await request("config");
        if(!next||typeof next.enabled!=="boolean")throw new Error("The backend did not return valid trading settings.");
      }catch{
        text("mode-badge","Demo controls unavailable");
        text("chart-availability-status","Genuine Demo controls could not load. Retrying automatically; practice profits do not change your Deriv balance.");
        el("chart-retry").hidden=false;el("chart-retry").disabled=false;
        retryTimer=setTimeout(load,retryDelay);retryDelay=Math.min(30000,retryDelay*2);
        return;
      }finally{retrying=false;}
      cfg=next;availability.remove();
      if(!cfg.enabled){practice.hidden=false;window.matchesLab?.setAvailable?.(true);text("mode-badge","Practice · account view");return;}
      mount();
    }
    el("chart-retry").addEventListener("click",()=>{void load();});
    void load();
  }
  function mount() {
    const section=document.createElement("section");section.className="card";section.id="chart-testing";section.style.position="relative";
    section.innerHTML=`
      <div class="card-kicker">Local chart rules · no AI credits</div>
      <p class="hint" id="chart-mode"></p>
      <details><summary id="chart-market-summary">Markets to scan</summary><div class="run-row"><button class="btn btn-outline btn-sm" id="chart-select-open" type="button">Select open markets</button><button class="btn btn-outline btn-sm" id="chart-clear-markets" type="button">Clear</button></div><div class="research-fields" id="chart-market-options"></div></details>
      <p class="hint" id="chart-current-market"></p>
      <details><summary>Latest market checks</summary><ul class="hint" id="chart-market-results"></ul></details>
      <div class="research-fields">
        <label class="field-label">Fixed stake ($)<input class="input" id="chart-stake" type="number" min="1" max="500" step="0.01" value="1.00"></label>
        <label class="field-label">Session profit target ($)<input class="input" id="chart-target" type="number" min="0.01" step="0.01" value="2.00"></label>
        <label class="field-label">Total loss limit ($)<input class="input" id="chart-loss" type="number" min="1" step="0.01" value="2.00"></label>
      </div>
      <label class="hint" id="chart-live-choice" hidden><input type="checkbox" id="chart-live-confirm"> I selected my Live account and want these controls to use real money.</label>
      <div class="run-row"><button class="btn btn-primary btn-lg" id="chart-start" type="button">Start</button><button class="btn btn-outline btn-lg" id="chart-pause" type="button" disabled>Pause</button><button class="btn btn-stop btn-lg" id="chart-stop" type="button" disabled>Stop</button></div>
      <p class="tile-value" id="chart-session-state" role="status"></p>
      <p class="hint" id="chart-status" role="status"></p><p class="form-error" id="chart-error" role="alert" hidden></p>
      <p class="hint" id="chart-check-times"></p>
      <div class="metric-grid"><div class="tile"><span class="tile-label">Wins</span><span class="tile-value win" id="chart-wins">0</span></div><div class="tile"><span class="tile-label">Losses</span><span class="tile-value loss" id="chart-losses">0</span></div><div class="tile"><span class="tile-label">Win rate</span><span class="tile-value" id="chart-rate">—</span></div><div class="tile"><span class="tile-label">Actual session P/L</span><span class="tile-value" id="chart-pnl">$0.00</span></div></div>
      <p class="hint" id="chart-contract"></p>
      <p class="hint">CRT + Giant Killer M15/H1 patterns run locally without AI credits. Other original documents stay preserved as reference. WAIT means no complete setup. Pause/Stop block new entries; Deriv exits remain attached.</p>
      <div class="card-kicker">Trade history</div>
      <div class="run-row"><button class="btn btn-outline btn-sm" id="chart-history-session" type="button" aria-pressed="true">This bot session</button><button class="btn btn-outline btn-sm" id="chart-history-account" type="button" aria-pressed="false">Deriv account</button></div>
      <p class="hint" id="chart-history-note"></p>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Market</th><th>Contract</th><th>Stake</th><th>P/L</th><th>Result</th></tr></thead><tbody id="chart-history"></tbody></table></div>
      <details><summary>Recover an existing contract</summary><button class="btn btn-outline btn-sm" id="chart-recover" type="button">Recover existing contract monitoring</button></details>`;
    const practice=el("matches-testing");practice.hidden=true;practice.after(section);
    for(const id of ["result-flash","result-announcer"])section.append(el(id));
    document.querySelector(".trail-wrap").hidden=true;
    document.querySelector("footer.disclaimer").textContent="Genuine Deriv Options accounts. Original strategies use closed live candles; incomplete setups wait. No fixed-profit promises.";
    document.querySelector(".dialog-sub").textContent="Official Deriv login returns you here. Account viewing does not start a trading session.";
    for(const name of ["start","pause","stop","recover"])el("chart-"+name).addEventListener("click",()=>{text("chart-error","");void action(name);});
    el("chart-live-confirm").addEventListener("change",render);
    el("chart-select-open").addEventListener("click",()=>{selectedSymbols=new Set(marketRows.filter(m=>m.supported && m.open).slice(0,16).map(m=>m.symbol));rememberMarkets();render();});
    el("chart-clear-markets").addEventListener("click",()=>{selectedSymbols.clear();rememberMarkets();render();});
    for(const choice of ["session","account"])el("chart-history-"+choice).addEventListener("click",()=>{historyView=choice;history();});
    for(const id of ["account-select","symbol-select"])el(id).addEventListener("change",event=>{
      if(run && (run.status==="running" || run.status==="paused" || run.pending)){
        event.stopImmediatePropagation();event.target.value=id==="account-select"?run.account_id:run.symbol;
        text("chart-error","Stop the current session before changing its account or market.");
      }
    },true);
    const saved=typeof ssGet==="function"?ssGet("del.chart.markets"):null;
    selectedSymbols=new Set(Array.isArray(saved)?saved.filter(s=>typeof s==="string").slice(0,16):[el("symbol-select").value]);
    render();void loadMarkets();void poll();setInterval(poll,2500);
  }
  void init();
})();
