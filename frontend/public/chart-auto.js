/* Original-strategy automatic controls. Credentials remain in the existing
 * server account session. Nothing runs until Start; Live also needs its server
 * flag and explicit selection. This script never sends Deriv socket orders. */
"use strict";
(() => {
  let cfg=null,run=null,busy=false,polling=false;
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
  const money=v=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(v);
  function render() {
    if(!cfg?.enabled || !el("chart-testing"))return;
    const account=state.view?.selected_account;
    const active=run && (run.status==="running" || run.status==="paused" || run.pending);
    const real=account?.type==="real";
    const enabled=Boolean(account && cfg[account.type+"_enabled"] && state.auth==="authorised");
    el("chart-live-choice").hidden=!real;
    el("chart-start").disabled=busy || active || !enabled || !cfg.ai_configured || !cfg.node_available || !cfg.worker_available || real && !el("chart-live-confirm").checked;
    el("chart-pause").disabled=busy || !run || !["running","paused"].includes(run.status);
    el("chart-pause").textContent=run?.status==="paused"?"Resume":"Pause";
    el("chart-stop").disabled=busy || !run || !["running","paused"].includes(run.status);
    for(const id of ["chart-stake","chart-target","chart-loss","chart-live-confirm","symbol-select","account-select"])el(id).disabled=Boolean(active || busy);
    text("chart-mode",run && active ? (run.mode==="real"?"LIVE money":"Genuine Demo contracts") : real?"Live account selected":"Demo account selected");
    text("chart-status",run?.error || run?.note || (!account?"Connect your Deriv account first.":!enabled?"Automatic execution is disabled for this account type.":!cfg.worker_available?"The backend scanner is missing. Complete the backend deployment first.":!cfg.ai_configured || !cfg.node_available?"Server setup is incomplete. AI vision slots and Node 24 are required.":"Ready. Start will check the original chart rules before any entry."));
    text("chart-wins",String(run?.wins || 0));text("chart-losses",String(run?.losses || 0));
    text("chart-rate",run?.settled?(100*run.win_rate).toFixed(1)+"%":"—");text("chart-pnl",money(run?.net || 0));
    el("chart-pnl").className="tile-value "+((run?.net || 0)>0?"win":(run?.net || 0)<0?"loss":"");
    text("chart-contract",run?.pending?"Deriv contract "+(run.pending.contract_id || "acknowledgement pending")+" · "+run.pending.status:"No open automatic contract.");
    const tbody=el("chart-history");tbody.textContent="";
    for(const row of (run?.history || []).slice(0,5)) {
      const tr=document.createElement("tr");
      for(const value of [String(row.contract_id),money(row.stake),money(row.profit),row.status]) {const td=document.createElement("td");td.textContent=value;tr.append(td);}
      tbody.append(tr);
    }
    text("mode-badge","Original chart strategies · "+(active?(run.mode==="real"?"Live":"Demo"):"automatic"));
    text("account-mode-note",cfg.real_enabled?"Genuine account display · trading starts only below":"Genuine account display · Live execution disabled");
  }
  async function action(name) {
    if(busy)return;busy=true;render();
    try {
      if(name==="start") {
        const a=state.view?.selected_account;
        if(!a || state.auth!=="authorised")throw new Error("Connect an authorized account first.");
        run=await request("start","POST",{account_id:a.id,mode:a.type,symbol:el("symbol-select").value,
          stake:Number(el("chart-stake").value),target:Number(el("chart-target").value),max_loss:Number(el("chart-loss").value),
          acknowledge_live:a.type==="real" && el("chart-live-confirm").checked});
      } else if(name==="recover") {
        run=await request("recover","POST",{account_id:state.view?.selected_account?.id});
      } else if(run)run=await request("control","POST",{run_id:run.id,action:name==="pause" && run.status==="paused"?"resume":name});
    } catch(e) {text("chart-error",e.message);}
    finally {busy=false;render();}
  }
  async function poll() {
    if(polling || busy || !state.csrf || state.auth!=="authorised"){render();return;}
    polling=true;
    try {const data=await request("status");run=data.run;}
    catch(e){text("chart-error",e.message);}
    finally{polling=false;render();}
  }
  async function init() {
    try{cfg=await request("config");}catch{return;}
    if(!cfg.enabled)return;
    const section=document.createElement("section");section.className="card";section.id="chart-testing";section.style.position="relative";
    section.innerHTML=`
      <div class="card-kicker">Original chart strategies · automatic Multipliers</div>
      <p class="hint" id="chart-mode"></p>
      <div class="research-fields">
        <label class="field-label">Fixed stake ($)<input class="input" id="chart-stake" type="number" min="1" max="500" step="0.01" value="1.00"></label>
        <label class="field-label">Session profit target ($)<input class="input" id="chart-target" type="number" min="0.01" step="0.01" value="2.00"></label>
        <label class="field-label">Total loss limit ($)<input class="input" id="chart-loss" type="number" min="1" step="0.01" value="2.00"></label>
      </div>
      <label class="hint" id="chart-live-choice" hidden><input type="checkbox" id="chart-live-confirm"> I selected my Live account and want these controls to use real money.</label>
      <div class="run-row"><button class="btn btn-primary btn-lg" id="chart-start" type="button">Start</button><button class="btn btn-outline btn-lg" id="chart-pause" type="button" disabled>Pause</button><button class="btn btn-stop btn-lg" id="chart-stop" type="button" disabled>Stop</button></div>
      <p class="hint" id="chart-status" role="status"></p><p class="form-error" id="chart-error" role="alert" hidden></p>
      <div class="metric-grid"><div class="tile"><span class="tile-label">Wins</span><span class="tile-value win" id="chart-wins">0</span></div><div class="tile"><span class="tile-label">Losses</span><span class="tile-value loss" id="chart-losses">0</span></div><div class="tile"><span class="tile-label">Win rate</span><span class="tile-value" id="chart-rate">—</span></div><div class="tile"><span class="tile-label">Actual session P/L</span><span class="tile-value" id="chart-pnl">$0.00</span></div></div>
      <p class="hint" id="chart-contract"></p>
      <p class="hint">Checks each closed 15-minute candle using your AI credits. WAIT means no entry. Pause and Stop prevent new entries; open contracts keep their Deriv stop and target. No guaranteed profit.</p>
      <details><summary>Recent genuine results / recovery</summary><div class="table-wrap"><table><thead><tr><th>Contract</th><th>Stake</th><th>P/L</th><th>Result</th></tr></thead><tbody id="chart-history"></tbody></table></div><button class="btn btn-outline btn-sm" id="chart-recover" type="button">Recover existing contract monitoring</button></details>`;
    const practice=el("matches-testing");practice.hidden=true;practice.after(section);
    for(const id of ["result-flash","result-announcer"])section.append(el(id));
    document.querySelector(".trail-wrap").hidden=true;
    document.querySelector("footer.disclaimer").textContent="Genuine Deriv Options accounts. Original strategies use closed live candles; incomplete setups wait. No fixed-profit promises.";
    document.querySelector(".dialog-sub").textContent="Official Deriv login returns you here. Account viewing does not start a trading session.";
    for(const name of ["start","pause","stop","recover"])el("chart-"+name).addEventListener("click",()=>{text("chart-error","");void action(name);});
    el("chart-live-confirm").addEventListener("change",render);
    render();void poll();setInterval(poll,2500);
  }
  void init();
})();
