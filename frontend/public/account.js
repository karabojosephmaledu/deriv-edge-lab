/* Account-centered display, adapted from the existing dashboard's market, OAuth and sound components.
 * No broker order controls. The original app.js and Python execution files remain unchanged. */
"use strict";
const $ = id => document.getElementById(id);
const SYMBOLS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"], ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"], ["R_100", "Volatility 100 Index"], ["1HZ10V", "Volatility 10 (1s) Index"],
  ["1HZ25V", "Volatility 25 (1s) Index"], ["1HZ50V", "Volatility 50 (1s) Index"], ["1HZ75V", "Volatility 75 (1s) Index"],
  ["1HZ100V", "Volatility 100 (1s) Index"],
];

const DEFAULT_CONFIG = {
  app_id: "34XxijT4LuhpHEsZVPfoc", // public Deriv App ID (not a secret); server config overrides it
  public_ws_url: "wss://api.derivws.com/trading/v1/options/ws/public",
  api_base: "https://api.derivws.com",
  oauth_ready: false,
  demo_execution_enabled: false,
  oauth_authorize_url: "https://auth.deriv.com/oauth2/auth",
};

const PKCE_KEY = "del.pkce", ACTIVE_KEY = "del.displayAccount", SETTINGS_KEY = "del.settings.v4";
const state = { cfg: {...DEFAULT_CONFIG}, selected: null, view: null, csrf: null, sessionView: null,
  checking: false, auth: "checking", error: null, generation: 0, controller: null,
  pub: null, feed: "connecting", trail: [], digits: [], lastEpoch: 0, lastTickAt: 0, retry: 1000, marketGeneration: 0,
  settings: { sound: true }, notices: new Map(), saved: [] };
function ssGet(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function ssSet(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function makeSocket(handlers) {
  const sock = {
    ws: null, reqId: 0, pending: new Map(), pingTimer: null, closedByUs: false,
    isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    },
    isBusy() {
      return !!this.ws && this.ws.readyState <= WebSocket.OPEN;
    },
    open(url) {
      this.closedByUs = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        if (handlers.onClose) handlers.onClose();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.pingTimer = setInterval(() => this.isOpen() && this.request({ ping: 1 }).catch(() => {}), 30000);
        if (handlers.onOpen) handlers.onOpen();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const entry = msg.req_id != null ? this.pending.get(msg.req_id) : null;
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(msg.req_id);
          if (msg.error) entry.reject(msg.error);
          else entry.resolve(msg);
        }
        if (handlers.onMessage) handlers.onMessage(msg);
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        for (const [, e] of this.pending) {
          clearTimeout(e.timer);
          e.reject(new Error("socket-closed"));
        }
        this.pending.clear();
        if (this.ws === ws) this.ws = null;
        if (!this.closedByUs && handlers.onClose) handlers.onClose();
      };
    },
    close() {
      this.closedByUs = true;
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
      }
      this.ws = null;
    },
    request(payload, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        if (!this.isOpen()) return reject(new Error("socket-closed"));
        const req_id = ++this.reqId;
        const entry = { resolve, reject, timer: setTimeout(() => {
          this.pending.delete(req_id);
          reject(new Error("timeout"));
        }, timeoutMs) };
        this.pending.set(req_id, entry);
        this.ws.send(JSON.stringify({ ...payload, req_id }));
      });
    },
  };
  return sock;
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const redirectUri = () => location.origin + "/api/deriv/callback";

async function startOAuth() {
  if (!state.cfg.oauth_ready) return toast("Login with Deriv needs the hosted app. Use an API token instead.", "error");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  ssSet(PKCE_KEY, { verifier, state: st });
  const q = new URLSearchParams({
    response_type: "code", client_id: state.cfg.app_id, redirect_uri: redirectUri(), scope: "trade account_manage",
    state: st, code_challenge: challenge, code_challenge_method: "S256",
  });
  location.href = state.cfg.oauth_authorize_url + "?" + q.toString();
}

let audioCtx = null;
function unlockAudio() {
  if (!state.settings.sound) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}
function playResultSound(win) {
  if (!state.settings.sound || !audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    (win ? [880, 1318.5] : [220, 164.8]).forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = win ? "sine" : "square";
      o.frequency.value = f;
      const t0 = now + i * 0.09;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(win ? 0.18 : 0.08, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0);
      o.stop(t0 + 0.18);
    });
  } catch {
    /* silent */
  }
}

function toast(message, kind) {
  const c = $("toast-container");
  const el = document.createElement("div");
  el.className = "toast " + (kind || "info");
  el.textContent = message;
  c.appendChild(el);
  while (c.children.length > 3) c.removeChild(c.firstChild);
  setTimeout(() => el.remove(), 3600);
}


function money(value, currency = state.view?.selected_account?.currency || "USD") {
  if (value === null || !Number.isFinite(Number(value))) return "Unavailable";
  const digits = ["BTC", "ETH", "LTC", "USDT", "USDC"].includes(currency) ? 8 : 2;
  try { return new Intl.NumberFormat("en-US", {style:"currency", currency, minimumFractionDigits:2, maximumFractionDigits:digits}).format(value); }
  catch { return Number(value).toFixed(digits) + " " + currency; }
}
const signed = (value, currency) => (value >= 0 ? "+" : "−") + money(Math.abs(value), currency);
const timestamp = value => value ? new Date(value * 1000).toLocaleString() : "not verified yet";
function renderSoundToggle() {
  $("sound-toggle").textContent = state.settings.sound ? "Sound ON" : "Sound OFF";
  $("sound-toggle").setAttribute("aria-pressed", String(state.settings.sound));
}
function renderAccount() {
  const data = state.view, acc = data?.selected_account;
  $("account-empty").hidden = !!acc; $("account-live").hidden = !acc;
  const status = state.checking ? "Checking account authorization…" : state.auth === "authorised" ? "Account authorized · balances and activity are read-only" : state.auth === "unavailable" ? "Account information unavailable — retry status" : "Connect with Deriv to view genuine account information";
  $("account-auth-status").textContent = status + (state.error ? ". " + state.error : "");
  $("connect-status").textContent = status;
  $("connect-button-nav").textContent = acc ? acc.id : state.checking ? "Checking…" : "Connect account";
  $("account-refresh").disabled = state.checking;
  $("token-connect-button").disabled = state.checking;
  if (!acc) return;
  $("account-owner").textContent = data.owner || acc.id;
  $("account-verified").textContent = data.balance_status === "available" ? "Verified" : "Last verified / unavailable";
  $("balance-value").textContent = money(acc.balance, acc.currency);
  $("balance-currency").textContent = acc.currency;
  $("account-type").textContent = acc.type === "real" ? "Real · view only" : "Demo";
  $("account-type").className = "badge badge-demo";
  $("currency-flag").hidden = true;
  $("account-loginid").textContent = acc.id + " · " + acc.currency + " · genuine Deriv account";
  $("account-balance-status").textContent = (data.balance_status === "available" ? "Balance verified" : "Balance refresh unavailable") + " · last checked " + timestamp(data.balance_updated_at) +
    ". " + (data.balance_error || "Refreshes about every 8 seconds while this page is open.") + (data.accounts_error ? " " + data.accounts_error : "");
  const selector = $("account-select"); selector.textContent = "";
  for (const a of data.accounts) selector.add(new Option(a.id + " · " + (a.type === "real" ? "Real · view only" : "Demo") + " · " + a.currency, a.id));
  selector.value = acc.id; selector.disabled = state.checking;
}
function cell(text) { const el = document.createElement("td"); el.textContent = text; return el; }
function renderActivity() {
  const data = state.view, contracts = data?.contracts || [], body = $("account-transactions"); body.textContent = "";
  const known = !!data?.contracts_updated_at;
  const wins = contracts.filter(r => r.profit > 0).length, losses = contracts.filter(r => r.profit < 0).length;
  const net = contracts.reduce((n,r) => n + r.profit, 0);
  $("stat-wins").textContent = known ? wins : "—"; $("stat-losses").textContent = known ? losses : "—";
  $("stat-win-rate").textContent = known && contracts.length ? (100*wins/contracts.length).toFixed(1)+"%" : "—";
  $("stat-pnl").textContent = known ? signed(net) : "—";
  $("stat-pnl").className = "tile-value " + (net > 0 ? "win" : net < 0 ? "loss" : "");
  $("settled-status").textContent = !data ? "Connect an account to view its genuine settlements." :
    (data.contracts_error ? data.contracts_error + " " : "") + (known ? contracts.length + " recent settled contracts (up to 50), not lifetime or research statistics. Last verified " + timestamp(data.contracts_updated_at) + "." : "No verified contract results available.");
  $("transaction-status").textContent = !data ? "No account selected." :
    (data.statement_error ? data.statement_error + " " : "") + (data.statement_updated_at ? "Latest " + data.transactions.length + " provider transactions (up to 50) · last verified " + timestamp(data.statement_updated_at) : "No verified transaction history available.");
  for (const row of data?.transactions || []) {
    const tr = document.createElement("tr");
    const description = cell(row.action + " · " + row.description); description.className = "transaction-description";
    const amount = cell(signed(row.amount)); amount.className = row.amount < 0 ? "pl-neg" : "pl-pos";
    tr.append(cell(timestamp(row.time)), description, amount, cell(money(row.balance_after)), cell(row.id)); body.append(tr);
  }
}
let flashTimer;
function notifyContracts(data, switched) {
  if (!data.contracts_updated_at) return;
  const key = data.session_view + ":" + data.selected_account.id;
  let seen = state.notices.get(key);
  if (!seen || switched) { state.notices.set(key, new Set(data.contracts.map(r => r.id))); return; }
  for (const row of [...data.contracts].reverse()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.profit === 0) continue;
    const el = $("result-flash"), win = row.profit > 0;
    el.className = "result-flash " + (win ? "win" : "loss");
    el.textContent = (win ? "WIN " : "LOSS ") + signed(row.profit) + " · genuine " + (data.selected_account.type === "real" ? "Real" : "Demo") + " settlement";
    $("result-announcer").textContent = el.textContent; el.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.hidden = true; }, 1200);
    playResultSound(win);
  }
  if (seen.size > 2000) state.notices.set(key, new Set([...seen].slice(-1000)));
}
async function api(path, method = "GET", body, signal) {
  if (!/^\/(?:config|session|token|disconnect|account-display(?:\?account_id=[^&]*)?)$/.test(path)) throw new Error("Only account connection and display requests are available.");
  const controller = signal ? null : new AbortController(), timer = controller ? setTimeout(() => controller.abort(), 55000) : null;
  try {
    const response = await fetch("/api/deriv" + path, {method, credentials:"same-origin", cache:"no-store", signal:signal || controller.signal,
      headers:method === "GET" ? {} : {"Content-Type":"application/json", ...(state.csrf ? {"X-Deriv-CSRF":state.csrf} : {})}, body:body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) { const e = new Error(typeof data.detail === "string" ? data.detail : "Account request unavailable. Retry status."); e.status = response.status; throw e; }
    return data;
  } finally { if (timer) clearTimeout(timer); }
}
async function refreshAccount(selected = state.selected) {
  const generation = ++state.generation;
  state.controller?.abort(); state.controller = new AbortController();
  const controller = state.controller, timer = setTimeout(() => controller.abort(), 55000);
  state.checking = true; state.error = null; renderAccount();
  try {
    const data = await api("/account-display" + (selected ? "?account_id=" + encodeURIComponent(selected) : ""), "GET", undefined, controller.signal);
    if (generation !== state.generation) return;
    if (data.authorization_status !== "authorised" || data.read_only !== true || !data.selected_account || !Array.isArray(data.accounts) || !Array.isArray(data.transactions) || !Array.isArray(data.contracts) || !["demo","real"].includes(data.selected_account.type) || typeof data.selected_account.currency !== "string" || selected && data.selected_account.id !== selected) throw new Error("No compatible authorized account information was returned.");
    const switched = state.view?.selected_account?.id !== data.selected_account.id;
    state.view = data; state.selected = data.selected_account.id; state.csrf = data.csrf; state.sessionView = data.session_view; state.auth = "authorised";
    ssSet(ACTIVE_KEY, state.selected); renderAccount(); renderActivity(); notifyContracts(data, switched);
  } catch (error) {
    if (generation !== state.generation) return;
    state.error = error.name === "AbortError" ? "Account request timed out. Retry status; no trade was sent." : error.message;
    state.auth = error.status === 401 ? "unauthorised" : "unavailable";
    if (error.status === 401 || selected !== state.view?.selected_account?.id) { state.view = null; renderActivity(); }
  } finally { clearTimeout(timer); if (generation === state.generation) { state.checking = false; renderAccount(); } }
}
function openConnectDialog() {
  $("oauth-block").hidden = !state.cfg.oauth_ready;
  if (!$("connect-dialog").open) $("connect-dialog").showModal();
}
function showConnectError(message) { $("connect-error").hidden = !message; $("connect-error").textContent = message || ""; }
async function finishLogin(path, body) {
  state.checking = true; renderAccount(); showConnectError("");
  try {
    const data = await api(path, "POST", body); state.csrf = data.csrf;
    state.notices.clear(); state.view = null;
    // A fresh authorization may expose different accounts. Let the server verify its default first.
    await refreshAccount(null);
    if (state.auth === "authorised") $("connect-dialog").close();
    else showConnectError(state.error || "Account display could not be verified. Retry status.");
  } catch (error) { state.error = error.name === "AbortError" ? "Account connection timed out. Retry login." : error.message; state.auth = "unavailable"; showConnectError(state.error); }
  finally { state.checking = false; renderAccount(); }
}
async function handleOAuthReturn() {
  const params = new URLSearchParams(location.hash.slice(1)), code = params.get("code"), error = params.get("error");
  if (!code && !error) return false;
  history.replaceState(null, "", location.pathname + location.search);
  const pkce = ssGet(PKCE_KEY); ssSet(PKCE_KEY, null);
  if (error || !pkce || pkce.state !== params.get("state")) { openConnectDialog(); showConnectError("Login was cancelled or its security check failed. Sign in again."); state.auth = "unauthorised"; return true; }
  await finishLogin("/token", {code, code_verifier:pkce.verifier, redirect_uri:redirectUri()});
  return true;
}
async function loadConfig(attempt = 0) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch("/api/deriv/config", {signal:controller.signal,cache:"no-store"});
    if (!r.ok) throw new Error("config"); const cfg = await r.json();
    if (typeof cfg.oauth_ready !== "boolean") throw new Error("config");
    state.cfg.oauth_ready = cfg.oauth_ready;
    if (cfg.app_id && cfg.app_id !== "1089") state.cfg.app_id = String(cfg.app_id);
    $("oauth-block").hidden = !state.cfg.oauth_ready;
  } catch { if (attempt < 4) setTimeout(() => loadConfig(attempt+1), 5000*(attempt+1)); }
  finally { clearTimeout(timer); }
}
function renderMarket() {
  $("connection-status-text").textContent = (state.feed === "live" ? "Live · " : state.feed === "unavailable" ? "Reconnecting · " : "Connecting · ") + $("symbol-select").value;
  $("status-dot").className = "dot " + (state.feed === "live" ? "dot-live" : "dot-warn");
  window.matchesLab?.render();
}
function tick(t) {
  const symbol = $("symbol-select").value;
  if (!t || t.symbol !== symbol || ![t.quote,t.pip_size,t.epoch].every(v => typeof v === "number" || typeof v === "string" && v.trim() !== "")) return;
  const price = Number(t.quote), pip = Number(t.pip_size), epoch = Number(t.epoch);
  if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(pip) || pip < 0 || pip > 20 || !Number.isInteger(epoch) || epoch <= state.lastEpoch) return;
  state.lastEpoch = epoch; state.lastTickAt = Date.now(); state.feed = "live"; renderMarket();
  const text = price.toFixed(pip), digit = Number(text.at(-1));
  $("quote-main").textContent = text.slice(0,-1); $("quote-digit").textContent = digit;
  $("quote-meta").textContent = (SYMBOLS.find(s => s[0] === symbol)?.[1] || symbol) + " · " + timestamp(epoch) + " · live";
  state.trail.unshift(digit); state.trail = state.trail.slice(0,10);
  state.digits.push(digit); state.digits = state.digits.slice(-100);
  const trail = $("tick-trail"); trail.textContent = "";
  for (let i=0;i<10;i++) { const el=document.createElement("span"); el.className="digit-cell"+(i===0?" newest":""); el.textContent=state.trail[i] ?? "·"; trail.append(el); }
  renderFrequency();
  window.matchesLab?.feed({symbol,price,pip,epoch});
}
function renderFrequency() {
  const counts=Array.from({length:10},(_,d)=>state.digits.filter(n=>n===d).length), max=Math.max(1,...counts), wrap=$("digit-frequency"); wrap.textContent="";
  counts.forEach((n,d)=>{const col=document.createElement("div"); col.className="freq-col"; col.title=d+": "+n+" of "+state.digits.length+" ticks";
    col.innerHTML='<div class="freq-track"><div class="freq-bar" style="height:'+(100*n/max)+'%"></div></div><span class="freq-label">'+d+'</span>'; wrap.append(col);});
}
async function subscribeMarket() {
  if(state.marketGeneration>0) window.matchesLab?.interrupt("Market feed restarted or changed · any open virtual result is unresolved");
  const gen=++state.marketGeneration, symbol=$("symbol-select").value;
  state.lastEpoch=0; state.trail=[]; state.digits=[]; state.feed="connecting"; renderMarket(); renderFrequency();
  $("quote-main").textContent="—"; $("quote-digit").textContent=""; $("tick-trail").textContent="";
  try {
    await state.pub.request({forget_all:"ticks"});
    if(gen!==state.marketGeneration || !state.pub.isOpen()) return;
    await state.pub.request({ticks:symbol,subscribe:1});
  } catch { state.feed="unavailable"; renderMarket(); }
}
function connectPublic() {
  if(state.pub?.isBusy())return;
  if(!state.pub) state.pub=makeSocket({onOpen:()=>{state.retry=1000; void subscribeMarket();},onMessage:m=>{if(m.msg_type==="tick")tick(m.tick);},onClose:()=>{
    window.matchesLab?.interrupt("Live market disconnected · any open virtual result is unresolved");
    state.feed="unavailable"; renderMarket(); const delay=state.retry; state.retry=Math.min(30000,state.retry*2); setTimeout(connectPublic,delay);
  }});
  state.pub.open(DEFAULT_CONFIG.public_ws_url);
}
async function loadMatches() {
  try {
    const r=await fetch("/research-evidence.json",{cache:"no-cache"}); if(!r.ok)throw new Error();
    const c=(await r.json()).categories.find(c=>c.id==="matches"); if(!c)throw new Error();
    $("matches-verdict").textContent="Historical verdict: "+c.verdict+" · "+c.trades+" virtual outcomes · "+signed(c.net,"USD")+". NO TRADE.";
    const prices=c.prices.filter(p=>!p.unavailable), range=(ns,format)=>{const vs=ns.filter(Number.isFinite);return vs.length?format(Math.min(...vs))+(Math.min(...vs)!==Math.max(...vs)?"–"+format(Math.max(...vs)):""):"Not established";};
    const percent=n=>(100*n).toFixed(2)+"%", usd=n=>money(n,"USD");
    const metrics=[["Hypothetical stake",usd(c.hypotheticalStake)],["Assumed gross payout",range(prices.map(p=>p.gross),usd)],["Profit on a win",range(prices.map(p=>p.profit),usd)],["Loss on a loss",usd(c.hypotheticalStake)],["Break-even wins",range(prices.map(p=>p.breakEven),percent)],["Observed wins",percent(c.winRate)],["Assumed EV at uniform 10% wins",range(prices.map(p=>p.expectedValue),usd)],["Historical total virtual P/L",signed(c.net,"USD")],["Worst-window drawdown",usd(c.maxDrawdown)],["Sample size",String(c.trades)]];
    const grid=$("matches-metrics");grid.textContent="";
    for(const [label,value]of metrics){const box=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd");dt.textContent=label;dd.textContent=value;box.append(dt,dd);grid.append(box);}
    $("matches-limitations").textContent=c.limitations;
  }catch{$("matches-verdict").textContent="Historical evidence unavailable. NO TRADE; no result was substituted.";}
}
function loadSavedResearch() {
  try {const old=JSON.parse(localStorage.getItem("del.virtual.session.v1")||"null"); state.saved=[old?.current,...(Array.isArray(old?.archives)?old.archives:[])].filter(s=>Array.isArray(s?.history)&&s.history.length).slice(0,21);}catch{}
  const selector=$("saved-session-select");
  state.saved.forEach((s,i)=>selector.add(new Option("Saved research session "+(i+1)+" · "+s.history.length+" historical records",String(i))));
  selector.disabled=!state.saved.length; renderSavedResearch();
}
function renderSavedResearch() {
  const saved=state.saved[Number($("saved-session-select").value)||0], body=$("saved-research-rows");body.textContent="";
  if(!saved){$("saved-research-stats").textContent="No previous research records saved in this browser.";return;}
  const st=saved.stats;
  $("saved-research-stats").textContent=st&&[st.wins,st.losses,st.net].every(Number.isFinite)?"Historical virtual session: "+st.wins+" wins · "+st.losses+" losses · "+signed(st.net,"USD")+" virtual P/L"+(Number.isFinite(st.maxDD)?" · historical drawdown "+money(st.maxDD,"USD"):"")+". Not a Deriv account result.":"Historical virtual records only.";
  for(const row of saved.history.slice(0,500)) {
    if(!row||!Number.isFinite(new Date(row.time).getTime()))continue;
    const tr=document.createElement("tr");tr.append(cell(new Date(row.time).toLocaleString()),cell(String(row.label||"Historical record")),cell(Number.isFinite(row.pnl)?signed(row.pnl,"USD"):"Unresolved"),cell(String(row.outcome||"Unknown")));body.append(tr);
  }
}
async function init() {
  try{const settings=JSON.parse(localStorage.getItem(SETTINGS_KEY)||"null");if(typeof settings?.sound==="boolean")state.settings.sound=settings.sound;}catch{}
  // Remove credentials left by pre-backend builds, without deleting research records.
  ssSet("del.cred",null); state.selected=ssGet(ACTIVE_KEY); if(typeof state.selected!=="string")state.selected=null;
  for(const [code,name]of SYMBOLS)$("symbol-select").add(new Option(name,code)); $("symbol-select").value="R_100";
  $("symbol-select").addEventListener("change",subscribeMarket);
  $("sound-toggle").addEventListener("click",()=>{state.settings.sound=!state.settings.sound;if(state.settings.sound)unlockAudio();else{audioCtx?.close?.();audioCtx=null;}try{const s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");localStorage.setItem(SETTINGS_KEY,JSON.stringify({...s,sound:state.settings.sound}));}catch{}renderSoundToggle();});
  document.addEventListener("pointerdown",()=>{if(state.settings.sound)unlockAudio();});
  for(const id of ["connect-button","connect-button-nav"])$(id).addEventListener("click",()=>{if(state.view && id==="connect-button-nav")$("account-card").scrollIntoView({behavior:"smooth"});else openConnectDialog();});
  $("oauth-connect-button").addEventListener("click",startOAuth);
  $("connect-cancel-button").addEventListener("click",()=>$("connect-dialog").close());
  $("token-form").addEventListener("submit",e=>{e.preventDefault();const token=$("token-input").value.trim();$("token-input").value="";if(token)void finishLogin("/session",{token});});
  $("account-select").addEventListener("change",e=>{state.selected=e.target.value;state.view=null;renderActivity();void refreshAccount(state.selected);});
  $("account-refresh").addEventListener("click",()=>refreshAccount());
  $("disconnect-button").addEventListener("click",async()=>{try{state.generation++;state.controller?.abort();state.checking=true;renderAccount();await api("/disconnect","POST",{});state.generation++;state.controller?.abort();state.view=null;state.selected=null;state.csrf=null;state.auth="unauthorised";state.error=null;state.checking=false;ssSet(ACTIVE_KEY,null);renderAccount();renderActivity();}catch(e){state.checking=false;state.error=e.message;state.auth="unavailable";renderAccount();toast(e.message,"error");}});
  $("saved-session-select").addEventListener("change",renderSavedResearch);
  renderSoundToggle();renderAccount();renderActivity();renderFrequency();loadSavedResearch();void loadMatches();void loadConfig();connectPublic();
  if(!await handleOAuthReturn())void refreshAccount();
  setInterval(()=>{if(!document.hidden&&!state.checking&&state.auth!=="unauthorised")void refreshAccount();},8000);
}
init();
