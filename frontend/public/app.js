/* ==========================================================================
 * Deriv Edge Lab — app.js
 *
 * Vanilla JavaScript. No frameworks, no build step, no dependencies.
 *
 * ARCHITECTURE
 *   - The browser connects DIRECTLY to Deriv's public WebSocket API
 *     (wss://ws.derivws.com/websockets/v3?app_id=<app_id>). Our backend is
 *     never in the market-data path.
 *   - Connection: "Login with Deriv" OAuth redirect (needs a registered
 *     app_id) or a Demo API token pasted into the dialog. Either way the
 *     token lives ONLY in this tab's sessionStorage and is sent ONLY to
 *     Deriv over TLS. Our servers never see it.
 *   - SIMULATOR: this app NEVER sends buy/sell. Every tick is scored against
 *     the chosen Matches/Differs condition as a virtual trade; payouts come
 *     from Deriv's live proposal quotes (no order is placed).
 * ========================================================================== */

"use strict";

/* ------------------------------ tiny helpers ----------------------------- */

const $ = (id) => document.getElementById(id);

const SYMBOLS = [
  { code: "R_10", name: "Volatility 10 Index" },
  { code: "R_25", name: "Volatility 25 Index" },
  { code: "R_50", name: "Volatility 50 Index" },
  { code: "R_75", name: "Volatility 75 Index" },
  { code: "R_100", name: "Volatility 100 Index" },
  { code: "1HZ10V", name: "Volatility 10 (1s) Index" },
  { code: "1HZ25V", name: "Volatility 25 (1s) Index" },
  { code: "1HZ50V", name: "Volatility 50 (1s) Index" },
  { code: "1HZ75V", name: "Volatility 75 (1s) Index" },
  { code: "1HZ100V", name: "Volatility 100 (1s) Index" },
];

const DEFAULT_CONFIG = {
  app_id: "1089", // Deriv's public test app_id
  ws_url: "wss://ws.derivws.com/websockets/v3",
  oauth_ready: false,
  oauth_url: null,
};

/* Used only when the live proposal quote is unavailable (e.g. offline). */
const FALLBACK_PAYOUTS = { matches: 8.7, differs: 1.09 };

const HISTORY_LIMIT = 60; // rows kept in the ledger
const TICK_TRAIL = 10; // digits shown in the strip
const FREQ_WINDOW = 100; // ticks behind the frequency chart
const STAKE_MIN = 0.35;
const STAKE_MAX = 5000;
const TOKEN_KEY = "del.token";

/* --------------------------------- state --------------------------------- */

const state = {
  cfg: { ...DEFAULT_CONFIG },
  ws: null,
  status: "connecting", // connecting | live | reconnecting | offline
  reqId: 0,
  pending: new Map(), // req_id -> { resolve, reject, timer }
  pingTimer: null,
  reconnectDelay: 1000,
  intentionalClose: false,
  feedAttempts: 0, // failed WS attempts before falling back to the demo feed
  demoFeed: false, // true while the synthetic demo feed is running
  demoTimer: null,
  demoSymbol: null,
  demoPrice: 0,
  authorized: false,
  account: null, // { loginid, currency, balance, isVirtual }
  settings: { symbol: "R_100", type: "differs", digit: 5, stake: 1.0 },
  running: false,
  trail: [], // newest-first [{ quoteStr, digit, epoch }]
  freq: new Array(10).fill(0), // rolling counts over FREQ_WINDOW
  freqQueue: [], // digits currently inside the window
  payout: { multiplier: FALLBACK_PAYOUTS.differs, source: "estimate" },
  payoutReqId: null, // only accept proposal updates for the active request
  payoutCooldownUntil: 0,
  stats: { trades: 0, wins: 0, losses: 0, net: 0, streak: 0 },
  history: [],
};

/* ------------------------------ persistence ------------------------------ */

function loadSettings() {
  try {
    const raw = localStorage.getItem("del.settings");
    if (!raw) return;
    const s = JSON.parse(raw);
    if (SYMBOLS.some((x) => x.code === s.symbol)) state.settings.symbol = s.symbol;
    if (s.type === "matches" || s.type === "differs") state.settings.type = s.type;
    const d = Number(s.digit);
    if (Number.isInteger(d) && d >= 0 && d <= 9) state.settings.digit = d;
    const st = Number(s.stake);
    if (Number.isFinite(st)) state.settings.stake = clampStake(st);
  } catch {
    /* corrupted settings are ignored — defaults stand */
  }
}

function saveSettings() {
  try {
    localStorage.setItem("del.settings", JSON.stringify(state.settings));
  } catch {
    /* storage unavailable — session-only settings */
  }
}

function clampStake(value) {
  if (!Number.isFinite(value)) return state.settings.stake;
  return Math.min(STAKE_MAX, Math.max(STAKE_MIN, Math.round(value * 100) / 100));
}

/* --------------------------------- config -------------------------------- */

async function loadConfig() {
  // The hosted app publishes its public config (app_id / OAuth readiness).
  // Any failure (e.g. running standalone on CodePen) keeps the defaults —
  // the app works fully without this call.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/api/deriv/config", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data.app_id === "string" && data.app_id) state.cfg.app_id = data.app_id;
    if (data && typeof data.ws_url === "string" && data.ws_url) state.cfg.ws_url = data.ws_url;
    state.cfg.oauth_ready = !!(data && data.oauth_ready && data.oauth_url);
    state.cfg.oauth_url = (data && data.oauth_url) || null;
  } catch {
    /* keep defaults */
  }
}

/* ------------------------------ token storage ---------------------------- */

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode — token then lives in memory only for this page */
  }
}

function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/* ----------------------------- OAuth redirect ---------------------------- */

/**
 * After "Login with Deriv", Deriv redirects to /api/deriv/callback#acct1=…
 * &token1=…&cur1=…. The backend bounces the #fragment to "/"; here we parse
 * it, prefer the Demo (VRTC…) account, store the token and clean the URL.
 */
function parseOAuthReturn() {
  if (!location.hash || location.hash.length < 2) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const accounts = [];
  for (let n = 1; n <= 25; n++) {
    const loginid = params.get("acct" + n);
    const token = params.get("token" + n);
    const currency = params.get("cur" + n);
    if (!loginid) break;
    if (token) accounts.push({ loginid, token, currency: (currency || "USD").toUpperCase() });
  }
  if (!accounts.length) return false;
  const demo = accounts.find((a) => a.loginid.startsWith("VRTC"));
  const chosen = demo || accounts[0];
  storeToken(chosen.token);
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

function startOAuth() {
  if (!state.cfg.oauth_ready) {
    openConnectDialog();
    return;
  }
  window.location.href = state.cfg.oauth_url;
}

/* ------------------------------ WebSocket core --------------------------- */

function wsOpen() {
  return state.ws && state.ws.readyState === WebSocket.OPEN;
}

function setStatus(status) {
  state.status = status;
  const dot = $("status-dot");
  const text = $("connection-status-text");
  dot.className = "dot";
  if (status === "live") {
    dot.classList.add("dot-live");
    text.textContent = "Live · " + state.settings.symbol;
  } else if (status === "demo") {
    dot.classList.add("dot-warn");
    text.textContent = "Demo feed · " + state.settings.symbol;
  } else if (status === "connecting") {
    dot.classList.add("dot-warn");
    text.textContent = "Connecting…";
  } else if (status === "reconnecting") {
    dot.classList.add("dot-warn");
    text.textContent = "Reconnecting…";
  } else {
    dot.classList.add("dot-off");
    text.textContent = "Offline";
  }
}

function scheduleReconnect() {
  if (state.intentionalClose) return;
  const jitter = Math.random() * 400;
  setTimeout(connectWs, state.reconnectDelay + jitter);
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    if (wsOpen()) request({ ping: 1 }).catch(() => {});
  }, 30000);
}

function stopPing() {
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  setStatus(state.demoFeed ? "demo" : state.ws ? "reconnecting" : "connecting");
  state.intentionalClose = false;

  let ws;
  try {
    ws = new WebSocket(state.cfg.ws_url + "?app_id=" + encodeURIComponent(state.cfg.app_id));
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectDelay = 1000;
    state.feedAttempts = 0;
    stopDemoTimer(); // real data is back — drop the synthetic feed
    setStatus("live");
    startPing();
    const token = getToken();
    if (token) {
      authorize(token);
    } else {
      subscribeTicks(state.settings.symbol);
      refreshPayout();
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    routeMessage(msg);
  };

  ws.onerror = () => {
    /* onclose always follows; reconnect logic lives there */
  };

  ws.onclose = () => {
    stopPing();
    failAllPending("socket-closed");
    state.authorized = false;
    state.account = null;
    renderAccount();
    state.feedAttempts += 1;
    if (state.feedAttempts >= 3 || state.demoFeed) {
      if (!state.demoFeed) startDemoFeed(); // Deriv unreachable here — labeled synthetic feed
      setStatus("demo");
    } else {
      setStatus("reconnecting");
    }
    scheduleReconnect();
  };
}

/**
 * Sends one request with a unique req_id and resolves with its first
 * response. Stream updates arrive later via routeMessage().
 * NOTE: trading calls (buy/sell) are deliberately refused — this is a
 * simulator and must never place a trade.
 */
function request(payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!wsOpen()) {
      reject(new Error("socket-closed"));
      return;
    }
    const body = { ...payload };
    if ("buy" in body || "sell" in body) {
      reject(new Error("trading calls are disabled in this simulator"));
      return;
    }
    const req_id = ++state.reqId;
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      state.pending.delete(req_id);
      reject(new Error("timeout"));
    }, timeoutMs);
    state.pending.set(req_id, entry);
    try {
      state.ws.send(JSON.stringify({ ...body, req_id }));
    } catch (err) {
      clearTimeout(entry.timer);
      state.pending.delete(req_id);
      reject(err);
    }
  });
}

function failAllPending(reason) {
  for (const [, entry] of state.pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  state.pending.clear();
}

function routeMessage(msg) {
  const isError = !!msg.error;
  const entry = msg.req_id != null ? state.pending.get(msg.req_id) : null;

  if (isError) handleApiError(msg.error);

  if (entry) {
    clearTimeout(entry.timer);
    state.pending.delete(msg.req_id);
    if (isError) entry.reject(msg.error);
    else entry.resolve(msg);
  }

  if (isError) return;

  switch (msg.msg_type) {
    case "tick":
      if (msg.tick) onTick(msg.tick);
      break;
    case "balance":
      if (msg.balance) onBalance(msg.balance);
      break;
    case "proposal":
      if (msg.proposal && msg.req_id === state.payoutReqId) onProposal(msg.proposal);
      break;
    default:
      break; // ping, forget_all, …
  }
}

function handleApiError(err) {
  const code = err && err.code ? err.code : "";
  const message = (err && err.message) || "Something went wrong talking to Deriv.";

  if (code === "InvalidToken" || code === "AuthorizationRequired") {
    clearToken();
    state.authorized = false;
    state.account = null;
    renderAccount();
    toast("That token was rejected — please connect again.", "error");
    openConnectDialog(message);
    return;
  }
  if (code === "RateLimits" || code === "RateLimitExceeded") {
    state.payoutCooldownUntil = Date.now() + 30000;
    state.payout = { multiplier: FALLBACK_PAYOUTS[state.settings.type], source: "estimate" };
    renderPayout();
    return;
  }
  if (code === "AlreadySubscribed") return;

  // Surface anything else in the connect dialog if the user is waiting there.
  const dialog = $("connect-dialog");
  if (dialog.open) showConnectError(message);
}

/* ------------------------------- connection ------------------------------ */

async function authorize(token) {
  try {
    const res = await request({ authorize: token });
    const a = res.authorize || {};
    state.authorized = true;
    const isVirtual =
      a.is_virtual === 1 || a.is_virtual === true || String(a.loginid || "").startsWith("VRTC");
    state.account = {
      loginid: a.loginid || "",
      currency: a.currency || "USD",
      balance: Number(a.balance) || 0,
      isVirtual,
    };
    renderAccount();
    toast("Connected to " + state.account.loginid, "success");
    request({ balance: 1, subscribe: 1 }).catch(() => {});
    subscribeTicks(state.settings.symbol);
    refreshPayout();
    closeConnectDialog();
    return true;
  } catch {
    return false; // handleApiError already showed the reason
  }
}

async function connectWithToken() {
  const input = $("token-input");
  const token = input.value.trim();
  if (!token) {
    showConnectError("Paste your Demo API token first.");
    return;
  }
  storeToken(token);
  if (!wsOpen()) {
    connectWs();
    if (state.demoFeed) {
      clearToken();
      showConnectError("Deriv is unreachable from this network, so the token can't be verified right now. The labeled demo feed keeps the simulator running; live connect works from a network that can reach Deriv.");
    } else {
      showConnectError("");
      toast("Connecting to Deriv…", "info");
    }
    return;
  }
  const ok = await authorize(token);
  if (!ok) {
    clearToken();
    input.value = "";
  }
}

function disconnect() {
  clearToken();
  state.authorized = false;
  state.account = null;
  if (wsOpen()) {
    request({ logout: 1 }).catch(() => {});
    request({ forget_all: "balance" }).catch(() => {});
  }
  renderAccount();
  toast("Disconnected — token cleared from this browser.", "info");
}

/* ------------------------------ subscriptions ---------------------------- */

function resetFeedState() {
  state.trail = [];
  state.freq = new Array(10).fill(0);
  state.freqQueue = [];
  renderTrail();
  renderFreq();
  renderQuote(null);
}

async function subscribeTicks(symbol) {
  if (state.demoFeed) {
    startDemoTimer(symbol); // stay on the synthetic feed until Deriv is reachable
    return;
  }
  if (!wsOpen()) return;
  try {
    await request({ forget_all: "ticks" }, 10000);
  } catch {
    /* socket may be going away; resubscribe below regardless */
  }
  resetFeedState();
  setStatus("live");
  try {
    await request({ ticks: symbol, subscribe: 1 });
  } catch {
    /* error already surfaced by handleApiError */
  }
}

/* ------------------------- synthetic demo feed ----------------------------
 * Runs ONLY when Deriv's gateway is unreachable from the current network
 * (some datacenter/hosting IPs are rejected by Deriv's edge). It is labeled
 * "Demo feed" everywhere it shows, and live data resumes automatically on
 * the first successful WebSocket connection.
 * ------------------------------------------------------------------------- */

const DEMO_BASES = {
  R_10: { price: 6234.503, pip: 3 },
  R_25: { price: 2712.883, pip: 3 },
  R_50: { price: 246.9142, pip: 4 },
  R_75: { price: 85432.1057, pip: 4 },
  R_100: { price: 6362.3452, pip: 2 },
  "1HZ10V": { price: 9841.22, pip: 2 },
  "1HZ25V": { price: 5123.882, pip: 3 },
  "1HZ50V": { price: 245.1188, pip: 4 },
  "1HZ75V": { price: 76432.1104, pip: 4 },
  "1HZ100V": { price: 6361.0125, pip: 2 },
};

function startDemoFeed() {
  if (state.demoFeed) return;
  startDemoTimer(state.settings.symbol);
  toast(
    "Deriv is unreachable from this network — running a clearly-labeled synthetic demo feed. Live data resumes automatically once Deriv is reachable.",
    "info"
  );
}

function startDemoTimer(symbol) {
  stopDemoTimer();
  state.demoFeed = true;
  state.demoSymbol = symbol;
  const base = DEMO_BASES[symbol] || DEMO_BASES.R_100;
  state.demoPrice = base.price;
  resetFeedState();
  setStatus("demo");
  const cadence = symbol.indexOf("1HZ") === 0 ? 1000 : 2000; // matches real tick cadence
  state.demoTimer = setInterval(() => {
    const drift = (Math.random() - 0.5) * 0.0016;
    state.demoPrice = Math.max(0.0001, state.demoPrice * (1 + drift));
    onTick({
      quote: state.demoPrice,
      pip_size: base.pip,
      epoch: Math.floor(Date.now() / 1000),
      symbol: state.demoSymbol,
    });
  }, cadence);
}

function stopDemoTimer() {
  if (state.demoTimer) {
    clearInterval(state.demoTimer);
    state.demoTimer = null;
  }
  state.demoFeed = false;
}

/* ------------------------------ live payouts ----------------------------- */

let payoutDebounce = null;

/**
 * Asks Deriv for a LIVE proposal quote for the current configuration.
 * proposal ≠ trade: it is a price quote only — nothing is ever bought.
 * `underlying_symbol` + `barrier` ("0"–"9") + 1-tick duration per the
 * digit Matches/Differs contract spec.
 */
function refreshPayout() {
  clearTimeout(payoutDebounce);
  payoutDebounce = setTimeout(async () => {
    const s = state.settings;
    if (!wsOpen() || Date.now() < state.payoutCooldownUntil) {
      state.payout = { multiplier: FALLBACK_PAYOUTS[s.type], source: "estimate" };
      renderPayout();
      return;
    }
    try {
      await request({ forget_all: "proposal" }, 10000);
      const res = await request({
        proposal: 1,
        amount: s.stake,
        basis: "stake",
        contract_type: s.type === "matches" ? "DIGITMATCH" : "DIGITDIFF",
        currency: state.account ? state.account.currency : "USD",
        duration: 1,
        duration_unit: "t",
        underlying_symbol: s.symbol,
        barrier: String(s.digit),
        subscribe: 1, // keep the payout live as the market moves
      });
      state.payoutReqId = res.req_id;
      onProposal(res.proposal);
    } catch {
      state.payout = { multiplier: FALLBACK_PAYOUTS[s.type], source: "estimate" };
      renderPayout();
    }
  }, 400);
}

/** Proposal payout/ask may arrive as strings — normalize defensively. */
function onProposal(proposal) {
  const payout = Number(proposal.payout);
  const ask = Number(proposal.ask_price) || state.settings.stake;
  if (Number.isFinite(payout) && payout > 0 && ask > 0) {
    state.payout = { multiplier: payout / ask, source: "live" };
  } else {
    state.payout = { multiplier: FALLBACK_PAYOUTS[state.settings.type], source: "estimate" };
  }
  renderPayout();
}

/* ------------------------------ market stream ---------------------------- */

function onTick(tick) {
  const pip = Number.isFinite(tick.pip_size) ? tick.pip_size : 2;
  const quoteStr = Number(tick.quote).toFixed(pip);
  const digit = Number(quoteStr.charAt(quoteStr.length - 1));

  state.trail.unshift({ quoteStr, digit, epoch: tick.epoch });
  if (state.trail.length > TICK_TRAIL) state.trail.pop();

  state.freq[digit] += 1;
  state.freqQueue.push(digit);
  if (state.freqQueue.length > FREQ_WINDOW) {
    const oldest = state.freqQueue.shift();
    state.freq[oldest] = Math.max(0, state.freq[oldest] - 1);
  }

  renderQuote({ quoteStr, digit, epoch: tick.epoch });
  renderTrail();
  renderFreq();

  if (state.running) settleTrade({ digit, symbol: tick.symbol });
}

/* ----------------------------- simulation core --------------------------- */

/** One simulated trade per tick — scored on the REAL last digit. */
function settleTrade(entry) {
  const s = state.settings;
  if (entry.symbol !== s.symbol) return; // stale tick from a previous market

  const win = s.type === "matches" ? entry.digit === s.digit : entry.digit !== s.digit;
  const stake = s.stake;
  const pnl = win
    ? Math.round(stake * (state.payout.multiplier - 1) * 100) / 100
    : -stake;

  const st = state.stats;
  st.trades += 1;
  if (win) {
    st.wins += 1;
    st.streak = st.streak >= 0 ? st.streak + 1 : 1;
  } else {
    st.losses += 1;
    st.streak = st.streak <= 0 ? st.streak - 1 : -1;
  }
  st.net = Math.round((st.net + pnl) * 100) / 100;

  state.history.unshift({
    time: new Date(),
    symbol: s.symbol,
    type: s.type,
    digit: s.digit,
    resultDigit: entry.digit,
    stake,
    win,
    pnl,
  });
  if (state.history.length > HISTORY_LIMIT) state.history.pop();

  renderStats();
  renderHistory();
  announceResult(win, pnl);
}

/* -------------------------------- formatting ----------------------------- */

const fmtCache = {};

function money(value, currency) {
  const cur = currency || (state.account ? state.account.currency : "USD");
  try {
    if (!fmtCache[cur]) {
      fmtCache[cur] = new Intl.NumberFormat("en-US", { style: "currency", currency: cur });
    }
    return fmtCache[cur].format(value);
  } catch {
    return value.toFixed(2) + " " + cur;
  }
}

function fmtSigned(value) {
  return (value >= 0 ? "+" : "−") + money(Math.abs(value));
}

function fmtClock(date) {
  return date.toLocaleTimeString([], { hour12: false });
}

function symbolName(code) {
  const found = SYMBOLS.find((s) => s.code === code);
  return found ? found.name : code;
}

/* -------------------------------- rendering ------------------------------ */

function renderAll() {
  renderStatus();
  renderAccount();
  renderStrategy();
  renderControls();
  renderQuote(null);
  renderTrail();
  renderFreq();
  renderPayout();
  renderStats();
  renderHistory();
}

function renderStatus() {
  setStatus(state.status);
}

function renderAccount() {
  const empty = $("account-empty");
  const live = $("account-live");
  const navBtn = $("connect-button-nav");
  const acc = state.account;

  if (acc) {
    empty.hidden = true;
    live.hidden = false;
    $("balance-value").textContent = money(acc.balance, acc.currency);
    $("balance-currency").textContent = acc.currency;
    $("account-loginid").textContent = acc.loginid + (acc.isVirtual ? " · demo" : " · real");
    const badge = $("account-type");
    badge.textContent = acc.isVirtual ? "Demo" : "Real";
    badge.className = "badge " + (acc.isVirtual ? "badge-demo" : "badge-real");
    navBtn.textContent = acc.loginid;
  } else {
    empty.hidden = false;
    live.hidden = true;
    navBtn.textContent = "Connect";
  }
}

function renderQuote(entry) {
  const main = $("quote-main");
  const digitEl = $("quote-digit");
  const meta = $("quote-meta");

  if (!entry) {
    main.textContent = "—";
    digitEl.textContent = "";
    meta.textContent = state.demoFeed
      ? "Synthetic demo feed — Deriv unreachable"
      : wsOpen()
        ? "Waiting for the first tick…"
        : "Connecting to Deriv…";
    return;
  }
  main.textContent = entry.quoteStr.slice(0, -1);
  digitEl.textContent = entry.digit;
  meta.textContent =
    symbolName(state.settings.symbol) +
    " · " + fmtClock(new Date(entry.epoch * 1000)) +
    (state.demoFeed ? " · synthetic demo feed" : "");

  digitEl.classList.remove("flash");
  void digitEl.offsetWidth; // restart the animation
  digitEl.classList.add("flash");
}

function renderTrail() {
  const wrap = $("tick-trail");
  wrap.textContent = "";
  for (let i = 0; i < TICK_TRAIL; i++) {
    const cell = document.createElement("span");
    cell.className = "digit-cell";
    const t = state.trail[i];
    if (!t) {
      cell.classList.add("placeholder");
      cell.textContent = "·";
    } else {
      cell.textContent = t.digit;
      if (i === 0) cell.classList.add("newest");
      if (t.digit === state.settings.digit) cell.classList.add("match");
    }
    wrap.appendChild(cell);
  }
}

function renderFreq() {
  const wrap = $("digit-frequency");
  wrap.textContent = "";
  const max = Math.max(1, ...state.freq);
  for (let d = 0; d <= 9; d++) {
    const col = document.createElement("div");
    col.className = "freq-col" + (d === state.settings.digit ? " selected" : "");

    const track = document.createElement("div");
    track.className = "freq-track";
    const bar = document.createElement("div");
    bar.className = "freq-bar";
    const count = state.freq[d];
    bar.style.height = (count / max) * 100 + "%";
    track.appendChild(bar);

    const label = document.createElement("span");
    label.className = "freq-label";
    label.textContent = String(d);

    const pct = state.freqQueue.length ? Math.round((count / state.freqQueue.length) * 100) : 0;
    col.title = d + " appeared in " + count + " of the last " + state.freqQueue.length + " ticks (" + pct + "%)";

    col.appendChild(track);
    col.appendChild(label);
    wrap.appendChild(col);
  }
}

function renderStrategy() {
  const isMatches = state.settings.type === "matches";
  $("trade-type-matches").setAttribute("aria-pressed", String(isMatches));
  $("trade-type-differs").setAttribute("aria-pressed", String(!isMatches));
  $("trade-type-description").textContent = isMatches
    ? "Wins when the last digit EQUALS your digit. Rare (~10%) but pays roughly 8–9×."
    : "Wins when the last digit is ANYTHING BUT your digit. Frequent (~90%) but pays roughly 1.1×.";

  for (const btn of document.querySelectorAll(".digit")) {
    const selected = Number(btn.dataset.digit) === state.settings.digit;
    btn.setAttribute("aria-pressed", String(selected));
  }

  const stakeInput = $("stake-input");
  if (document.activeElement !== stakeInput) stakeInput.value = state.settings.stake.toFixed(2);
}

function renderPayout() {
  const s = state.settings;
  const m = state.payout.multiplier;
  $("payout-mult").textContent = (state.payout.source === "live" ? "" : "≈") + m.toFixed(2) + "×";
  const winReturn = Math.round(s.stake * m * 100) / 100;
  $("payout-detail").textContent =
    (state.payout.source === "live" ? "Live quote" : "Estimate") +
    " — win returns " + money(winReturn) + " · risk " + money(s.stake) + " per simulated trade";
}

function renderControls() {
  $("start-simulation-btn").disabled = state.running;
  $("stop-simulation-btn").disabled = !state.running;
  $("running-indicator").hidden = !state.running;
}

function renderStats() {
  const st = state.stats;
  $("stat-wins").textContent = String(st.wins);
  $("stat-losses").textContent = String(st.losses);
  $("stat-win-rate").textContent = st.trades ? Math.round((st.wins / st.trades) * 100) + "%" : "—";

  const pnlEl = $("stat-pnl");
  pnlEl.textContent = st.net === 0 ? money(0) : fmtSigned(st.net);
  pnlEl.classList.toggle("win", st.net > 0);
  pnlEl.classList.toggle("loss", st.net < 0);

  $("stat-trades").textContent = st.trades + (st.trades === 1 ? " trade" : " trades");
  $("stat-streak").textContent =
    st.streak > 0 ? "streak W" + st.streak : st.streak < 0 ? "streak L" + Math.abs(st.streak) : "streak —";
}

function renderHistory() {
  const body = $("trade-history-body");
  const emptyMsg = $("trade-history-empty");
  body.textContent = "";

  emptyMsg.hidden = state.history.length > 0;

  for (const t of state.history) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = fmtClock(t.time);

    const tdMarket = document.createElement("td");
    tdMarket.textContent = t.symbol;

    const tdContract = document.createElement("td");
    tdContract.textContent = (t.type === "matches" ? "Matches " : "Differs ") + t.digit;

    const tdDigits = document.createElement("td");
    tdDigits.textContent = t.digit + " → " + t.resultDigit;

    const tdStake = document.createElement("td");
    tdStake.textContent = money(t.stake);

    const tdPnl = document.createElement("td");
    tdPnl.textContent = fmtSigned(t.pnl);
    tdPnl.className = t.pnl >= 0 ? "pl-pos" : "pl-neg";

    const tdResult = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + (t.win ? "badge-win" : "badge-loss");
    badge.textContent = t.win ? "Win" : "Loss";
    tdResult.appendChild(badge);

    tr.append(tdTime, tdMarket, tdContract, tdDigits, tdStake, tdPnl, tdResult);
    body.appendChild(tr);
  }
}

function announceResult(win, pnl) {
  $("result-announcer").textContent = (win ? "Win " : "Loss ") + fmtSigned(pnl);
  const tile = $("stat-pnl").parentElement;
  tile.classList.remove("win-burst", "loss-pulse");
  void tile.offsetWidth;
  tile.classList.add(win ? "win-burst" : "loss-pulse");
}

/* ----------------------------- connect dialog ---------------------------- */

function openConnectDialog(prefillError) {
  const dialog = $("connect-dialog");
  showConnectError(prefillError || "");
  $("oauth-block").hidden = !state.cfg.oauth_ready;
  $("oauth-setup-note").hidden = state.cfg.oauth_ready;
  $("token-divider").hidden = false;
  if (dialog.open) return;
  dialog.showModal();
  $("token-input").focus();
}

function closeConnectDialog() {
  const dialog = $("connect-dialog");
  if (dialog.open) dialog.close();
  $("token-input").value = "";
  showConnectError("");
}

function showConnectError(message) {
  const el = $("connect-error");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
  } else {
    el.hidden = false;
    el.textContent = message;
  }
}

/* --------------------------------- toasts -------------------------------- */

function toast(message, kind) {
  const container = $("toast-container");
  const el = document.createElement("div");
  el.className = "toast " + (kind || "info");
  el.textContent = message;
  container.appendChild(el);
  while (container.children.length > 3) container.removeChild(container.firstChild);
  setTimeout(() => el.remove(), 3200);
}

/* ------------------------------ user actions ----------------------------- */

function setTradeType(type) {
  if (state.settings.type === type) return;
  state.settings.type = type;
  saveSettings();
  renderStrategy();
  renderTrail();
  renderFreq();
  renderPayout();
  refreshPayout();
}

function selectDigit(digit) {
  if (state.settings.digit === digit) return;
  state.settings.digit = digit;
  saveSettings();
  renderStrategy();
  renderTrail();
  renderFreq();
  refreshPayout();
}

function setStake(value) {
  state.settings.stake = clampStake(Number(value));
  saveSettings();
  renderStrategy();
  renderPayout();
  refreshPayout();
}

function startSimulation() {
  if (state.running) return;
  state.running = true;
  renderControls();
  if (!wsOpen()) toast("Waiting for live market data…", "info");
}

function stopSimulation() {
  state.running = false;
  renderControls();
}

function resetSession() {
  state.stats = { trades: 0, wins: 0, losses: 0, net: 0, streak: 0 };
  state.history = [];
  renderStats();
  renderHistory();
  toast("Session reset.", "info");
}

/* --------------------------------- events -------------------------------- */

function bindEvents() {
  // Market selector
  const select = $("symbol-select");
  for (const s of SYMBOLS) {
    const opt = document.createElement("option");
    opt.value = s.code;
    opt.textContent = s.name;
    select.appendChild(opt);
  }
  select.value = state.settings.symbol;
  select.addEventListener("change", () => {
    state.settings.symbol = select.value;
    saveSettings();
    subscribeTicks(select.value);
    refreshPayout();
    renderPayout();
  });

  // Trade type + digits
  $("trade-type-matches").addEventListener("click", () => setTradeType("matches"));
  $("trade-type-differs").addEventListener("click", () => setTradeType("differs"));
  for (const btn of document.querySelectorAll(".digit")) {
    btn.addEventListener("click", () => selectDigit(Number(btn.dataset.digit)));
  }

  // Stake
  $("stake-input").addEventListener("change", (e) => setStake(e.target.value));
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => setStake(chip.dataset.stake));
  }

  // Simulation
  $("start-simulation-btn").addEventListener("click", startSimulation);
  $("stop-simulation-btn").addEventListener("click", stopSimulation);
  $("reset-stats-btn").addEventListener("click", resetSession);

  // Connection
  $("connect-button").addEventListener("click", () => openConnectDialog());
  $("connect-button-nav").addEventListener("click", () => openConnectDialog());
  $("oauth-connect-button").addEventListener("click", startOAuth);
  $("token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectWithToken();
  });
  $("connect-cancel-button").addEventListener("click", () => closeConnectDialog());
  $("disconnect-button").addEventListener("click", disconnect);
  $("connect-dialog").addEventListener("click", (e) => {
    if (e.target === $("connect-dialog")) closeConnectDialog(); // backdrop click
  });

  // Keyboard shortcuts: 0–9 pick a digit, ←/→ adjust. Skipped while typing.
  document.addEventListener("keydown", (e) => {
    if ($("connect-dialog").open) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (/^[0-9]$/.test(e.key)) {
      selectDigit(Number(e.key));
    } else if (e.key === "ArrowRight") {
      selectDigit((state.settings.digit + 1) % 10);
    } else if (e.key === "ArrowLeft") {
      selectDigit((state.settings.digit + 9) % 10);
    }
  });
}

/* ---------------------------------- init --------------------------------- */

async function init() {
  const oauthReturned = parseOAuthReturn();
  loadSettings();
  bindEvents();
  renderAll();
  await loadConfig();
  if (oauthReturned) {
    toast("Signed in with Deriv — connecting your account…", "info");
  }
  connectWs();
}

init();
