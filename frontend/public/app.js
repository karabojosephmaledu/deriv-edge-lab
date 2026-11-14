/* ==========================================================================
 * Deriv Edge Lab — app.js
 *
 * Vanilla JavaScript. No frameworks, no build step, no dependencies.
 * Built on the NEW Deriv API platform (developers.deriv.com).
 *
 * ARCHITECTURE
 *   - Market data + live payout quotes: Deriv's PUBLIC WebSocket
 *       wss://api.derivws.com/trading/v1/options/ws/public   (no auth)
 *   - Sign-in, either:
 *       a) "Login with Deriv" — OAuth2 Authorization Code + PKCE at
 *          auth.deriv.com. The tiny backend only swaps the code for a token
 *          (auth.deriv.com forbids browser CORS) and stores nothing.
 *       b) A Personal Access Token (PAT) pasted in the dialog — fully
 *          client-side, works even standalone on CodePen.
 *     Tokens live ONLY in this tab's sessionStorage.
 *   - Accounts: GET https://api.derivws.com/trading/v1/options/accounts
 *     → the user picks Demo or Real in the account switcher.
 *   - Trading: POST …/accounts/{id}/otp → one-time WebSocket URL for THAT
 *     account → balance stream, `buy`, `proposal_open_contract`.
 *   - TWO MODES:
 *       Simulate   — scores every tick virtually; nothing is sent to Deriv.
 *       Live trade — buys REAL 1-tick DIGITMATCH/DIGITDIFF contracts on the
 *                    selected account. Demo = virtual funds. Real money
 *                    needs an explicit red confirmation every session.
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

/* Defaults keep the app fully working standalone (e.g. CodePen, no backend). */
const DEFAULT_CONFIG = {
  app_id: "",
  public_ws_url: "wss://api.derivws.com/trading/v1/options/ws/public",
  api_base: "https://api.derivws.com",
  oauth_ready: false,
  oauth_authorize_url: "https://auth.deriv.com/oauth2/auth",
};

/* Used only until live proposal quotes arrive. */
const FALLBACK_PAYOUTS = { matches: 8.7, differs: 1.09 };

const HISTORY_LIMIT = 60;
const TICK_TRAIL = 10;
const FREQ_WINDOW = 100;
const STAKE_MIN = 0.35;
const STAKE_MAX = 5000;
const MAX_OPEN_CONTRACTS = 2; // never pile up unsettled live buys

const CRED_KEY = "del.cred"; // sessionStorage: { token, kind: "oauth"|"pat", expiresAt }
const ACTIVE_KEY = "del.activeAccount"; // sessionStorage
const PKCE_KEY = "del.pkce"; // sessionStorage: { verifier, state }
const APPID_KEY = "del.appid"; // localStorage: optional App ID override

/* --------------------------------- state --------------------------------- */

const state = {
  cfg: { ...DEFAULT_CONFIG },
  pub: null, // public market socket
  trade: null, // OTP trading socket for the active account
  status: "connecting", // connecting | live | demo | reconnecting
  feedAttempts: 0,
  demoFeed: false,
  demoTimer: null,
  demoSymbol: null,
  demoPrice: 0,
  cred: null,
  accounts: [], // [{ id, currency, balance, isVirtual }]
  account: null, // active account (above shape), set once its trade socket opens
  activeId: null,
  connecting: false,
  tradeRetryDelay: 1000,
  tradeMode: "sim", // never persisted — every load starts in Simulate
  realArmed: false, // session-only consent for real-money accounts
  settings: { symbol: "R_100", type: "differs", digit: 5, stake: 1.0, smartEntry: true, tp: null, sl: null },
  running: false,
  trail: [],
  freq: new Array(10).fill(0),
  freqQueue: [],
  digitPayouts: new Array(10).fill(null),
  payoutReqs: new Map(), // req_id -> digit
  payoutGen: 0, // invalidates stale payout loops
  payout: { multiplier: FALLBACK_PAYOUTS.differs, source: "estimate" },
  openContracts: new Map(), // contract_id -> { digit, type, stake, symbol }
  inflightBuys: 0,
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
    state.settings.smartEntry = s.smartEntry !== false;
    const tp = Number(s.tp);
    state.settings.tp = Number.isFinite(tp) && tp > 0 ? tp : null;
    const sl = Number(s.sl);
    state.settings.sl = Number.isFinite(sl) && sl > 0 ? sl : null;
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

function ssGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function ssSet(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode — memory only */
  }
}

/* --------------------------------- config -------------------------------- */

function getAppId() {
  let override = "";
  try {
    override = (localStorage.getItem(APPID_KEY) || "").trim();
  } catch {
    /* ignore */
  }
  return override || state.cfg.app_id || "";
}

function oauthAvailable() {
  // OAuth needs the backend (token exchange) and a registered App ID.
  return state.cfg.oauth_ready && !!getAppId();
}

async function loadConfig() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/api/deriv/config", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.app_id && data.app_id !== "1089") state.cfg.app_id = String(data.app_id);
    if (data && data.public_ws_url) state.cfg.public_ws_url = data.public_ws_url;
    if (data && data.api_base) state.cfg.api_base = data.api_base;
    if (data && data.oauth_authorize_url) state.cfg.oauth_authorize_url = data.oauth_authorize_url;
    state.cfg.oauth_ready = !!(data && data.oauth_ready);
  } catch {
    /* standalone — keep defaults (PAT connect still works) */
  }
}

/* ---------------------------- generic socket ----------------------------- */

/**
 * One WebSocket with req_id routing. `onMessage` sees every message;
 * request() resolves with the first response to its req_id.
 */
function makeSocket(name, handlers) {
  const sock = {
    name,
    ws: null,
    reqId: 0,
    pending: new Map(),
    pingTimer: null,
    closedByUs: false,
    isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    },
    isBusy() {
      return !!this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING);
    },
    open(url) {
      this.closedByUs = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        if (handlers.onClose) handlers.onClose(this);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.pingTimer = setInterval(() => {
          if (this.isOpen()) this.request({ ping: 1 }).catch(() => {});
        }, 30000);
        if (handlers.onOpen) handlers.onOpen(this);
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
        if (handlers.onMessage) handlers.onMessage(msg, this);
      };
      ws.onerror = () => {
        /* onclose always follows */
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        for (const [, e] of this.pending) {
          clearTimeout(e.timer);
          e.reject(new Error("socket-closed"));
        }
        this.pending.clear();
        if (this.ws === ws) this.ws = null;
        if (!this.closedByUs && handlers.onClose) handlers.onClose(this);
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
        if (!this.isOpen()) {
          reject(new Error("socket-closed"));
          return;
        }
        const req_id = ++this.reqId;
        const entry = { resolve, reject, timer: null };
        entry.timer = setTimeout(() => {
          this.pending.delete(req_id);
          reject(new Error("timeout"));
        }, timeoutMs);
        this.pending.set(req_id, entry);
        try {
          this.ws.send(JSON.stringify({ ...payload, req_id }));
        } catch (err) {
          clearTimeout(entry.timer);
          this.pending.delete(req_id);
          reject(err);
        }
      });
    },
  };
  return sock;
}

/* --------------------------- public market socket ------------------------ */

let pubRetryDelay = 1000;

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
  } else if (status === "reconnecting") {
    dot.classList.add("dot-warn");
    text.textContent = "Reconnecting…";
  } else {
    dot.classList.add("dot-warn");
    text.textContent = "Connecting…";
  }
}

function connectPublic() {
  if (state.pub && state.pub.isBusy()) return;
  setStatus(state.demoFeed ? "demo" : state.pub ? "reconnecting" : "connecting");
  if (!state.pub) {
    state.pub = makeSocket("public", {
      onOpen: () => {
        pubRetryDelay = 1000;
        state.feedAttempts = 0;
        stopDemoTimer();
        setStatus("live");
        subscribeTicks(state.settings.symbol);
        subscribePayouts();
      },
      onMessage: onPublicMessage,
      onClose: () => {
        state.feedAttempts += 1;
        if (state.feedAttempts >= 3 || state.demoFeed) {
          if (!state.demoFeed) startDemoFeed();
          setStatus("demo");
        } else {
          setStatus("reconnecting");
        }
        setTimeout(connectPublic, pubRetryDelay + Math.random() * 400);
        pubRetryDelay = Math.min(pubRetryDelay * 2, 30000);
      },
    });
  }
  state.pub.open(state.cfg.public_ws_url);
}

function onPublicMessage(msg) {
  if (msg.error) {
    const code = msg.error.code || "";
    if (code === "RateLimit" || code === "RateLimits" || code === "RateLimitExceeded") {
      toast("Deriv rate limit hit — payouts show estimates briefly.", "info");
    }
    return;
  }
  if (msg.msg_type === "tick" && msg.tick) onTick(msg.tick);
  else if (msg.msg_type === "proposal" && msg.proposal && state.payoutReqs.has(msg.req_id)) {
    applyDigitProposal(msg.req_id, msg.proposal);
  }
}

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
    startDemoTimer(symbol);
    return;
  }
  if (!state.pub || !state.pub.isOpen()) return;
  try {
    await state.pub.request({ forget_all: "ticks" }, 10000);
  } catch {
    /* resubscribe regardless */
  }
  resetFeedState();
  setStatus("live");
  try {
    await state.pub.request({ ticks: symbol, subscribe: 1 });
  } catch (err) {
    toast("Could not subscribe to " + symbol + ": " + errText(err), "error");
  }
}

/* ------------------------- synthetic demo feed ----------------------------
 * Runs ONLY when Deriv's public gateway is unreachable from this network.
 * Labeled "Demo feed" everywhere; live data resumes automatically.
 * Live trading never runs on it (buys need the real account socket).
 * ------------------------------------------------------------------------- */

const DEMO_BASES = {
  R_10: { price: 6234.503, pip: 3 },
  R_25: { price: 2712.883, pip: 3 },
  R_50: { price: 246.9142, pip: 4 },
  R_75: { price: 85432.1057, pip: 4 },
  R_100: { price: 572.26, pip: 2 },
  "1HZ10V": { price: 9841.22, pip: 2 },
  "1HZ25V": { price: 5123.882, pip: 3 },
  "1HZ50V": { price: 245.1188, pip: 4 },
  "1HZ75V": { price: 76432.1104, pip: 4 },
  "1HZ100V": { price: 6361.0125, pip: 2 },
};

function startDemoFeed() {
  if (state.demoFeed) return;
  startDemoTimer(state.settings.symbol);
  toast("Deriv is unreachable from this network — showing a labeled demo feed until it's back.", "info");
}

function startDemoTimer(symbol) {
  stopDemoTimer();
  state.demoFeed = true;
  state.demoSymbol = symbol;
  const base = DEMO_BASES[symbol] || DEMO_BASES.R_100;
  state.demoPrice = base.price;
  resetFeedState();
  setStatus("demo");
  const cadence = symbol.indexOf("1HZ") === 0 ? 1000 : 2000;
  state.demoTimer = setInterval(() => {
    state.demoPrice = Math.max(0.0001, state.demoPrice * (1 + (Math.random() - 0.5) * 0.0016));
    onTick({ quote: state.demoPrice, pip_size: base.pip, epoch: Math.floor(Date.now() / 1000), symbol: state.demoSymbol });
  }, cadence);
}

function stopDemoTimer() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
  state.demoFeed = false;
}

/* ---------------------- live payout ticker (all digits) ------------------ */

let payoutDebounce = null;

function keepPayoutsFresh() {
  clearTimeout(payoutDebounce);
  payoutDebounce = setTimeout(subscribePayouts, 500);
}

/**
 * Streams a live proposal quote for EVERY digit 0–9 so each button shows its
 * real current payout multiplier. Quotes only — nothing is bought here.
 */
async function subscribePayouts() {
  const gen = ++state.payoutGen;
  state.digitPayouts = new Array(10).fill(null);
  renderDigitPayouts();
  renderPayout();
  const pub = state.pub;
  if (state.demoFeed || !pub || !pub.isOpen()) return;
  try {
    await pub.request({ forget_all: "proposal" }, 10000);
  } catch {
    /* continue */
  }
  if (gen !== state.payoutGen) return;
  state.payoutReqs.clear();
  const s = state.settings;
  const currency = state.account ? state.account.currency : "USD";
  for (let d = 0; d <= 9; d++) {
    if (gen !== state.payoutGen || !pub.isOpen()) return;
    try {
      const res = await pub.request({
        proposal: 1,
        amount: s.stake,
        basis: "stake",
        contract_type: s.type === "matches" ? "DIGITMATCH" : "DIGITDIFF",
        currency,
        duration: 1,
        duration_unit: "t",
        underlying_symbol: s.symbol,
        barrier: String(d),
        subscribe: 1,
      });
      if (gen !== state.payoutGen) return;
      state.payoutReqs.set(res.req_id, d);
      if (res.proposal) applyDigitProposal(res.req_id, res.proposal);
    } catch (err) {
      const code = err && err.code ? err.code : "";
      if (code.indexOf("RateLimit") === 0) return;
    }
  }
}

/** Proposal payout/ask may be numbers or strings — normalize defensively. */
function applyDigitProposal(reqId, proposal) {
  const d = state.payoutReqs.get(reqId);
  if (d == null) return;
  const payout = Number(proposal.payout);
  const ask = Number(proposal.ask_price) || state.settings.stake;
  if (Number.isFinite(payout) && payout > 0 && ask > 0) state.digitPayouts[d] = payout / ask;
  renderDigitPayouts();
  if (d === state.settings.digit) renderPayout();
}

/* ------------------------------ REST helpers ----------------------------- */

function errText(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.message || err.code || "unknown error";
}

async function derivRest(method, path) {
  const cred = state.cred;
  if (!cred) throw new Error("Not connected");
  const headers = { Authorization: "Bearer " + cred.token };
  if (cred.kind === "pat") {
    const appId = getAppId();
    if (!appId) throw new Error("Add your App ID (developers.deriv.com → Apps) to use an API token.");
    headers["Deriv-App-ID"] = appId;
  }
  if (method !== "GET") headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(state.cfg.api_base + path, { method, headers, body: method === "GET" ? undefined : "{}" });
  } catch {
    throw new Error("Could not reach Deriv's API from this network.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = new Error(
      (data && (data.message || (data.error && data.error.message) || (data.errors && data.errors[0] && data.errors[0].message))) ||
        "Deriv returned HTTP " + res.status
    );
    e.status = res.status;
    throw e;
  }
  return data;
}

/* ------------------------------ sign-in flow ----------------------------- */

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function redirectUri() {
  return location.origin + "/api/deriv/callback";
}

async function startOAuth() {
  if (!oauthAvailable()) {
    toast("Login with Deriv needs the hosted app + your App ID. Use an API token instead.", "error");
    return;
  }
  if (!window.crypto || !crypto.subtle) {
    toast("This browser can't do secure login (needs HTTPS).", "error");
    return;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  ssSet(PKCE_KEY, { verifier, state: st });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getAppId(),
    redirect_uri: redirectUri(),
    scope: "trade",
    state: st,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.href = state.cfg.oauth_authorize_url + "?" + params.toString();
}

/**
 * Handles the return from auth.deriv.com. The backend callback moved
 * ?code&state into the #fragment; we verify state, swap the code for a
 * token via the backend, and wipe the URL.
 */
async function handleOAuthReturn() {
  if (!location.hash || location.hash.length < 2) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return false;
  history.replaceState(null, "", location.pathname + location.search);

  if (error) {
    toast("Deriv login cancelled: " + (params.get("error_description") || error), "error");
    return true;
  }
  const pkce = ssGet(PKCE_KEY);
  ssSet(PKCE_KEY, null);
  if (!pkce || pkce.state !== params.get("state")) {
    toast("Login check failed (state mismatch) — please try again.", "error");
    return true;
  }
  try {
    const res = await fetch("/api/deriv/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pkce.verifier, redirect_uri: redirectUri() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
      throw new Error((data && data.detail) || "token exchange failed");
    }
    setCred({ token: data.access_token, kind: "oauth", expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
    toast("Signed in with Deriv — loading your accounts…", "success");
    await connectAccounts();
  } catch (err) {
    toast("Deriv login failed: " + errText(err), "error");
  }
  return true;
}

function setCred(cred) {
  state.cred = cred;
  ssSet(CRED_KEY, cred);
}

function loadCred() {
  const c = ssGet(CRED_KEY);
  if (c && c.token && (!c.expiresAt || c.expiresAt > Date.now())) state.cred = c;
  else ssSet(CRED_KEY, null);
  const a = ssGet(ACTIVE_KEY);
  if (typeof a === "string") state.activeId = a;
}

/** Lists the user's Options accounts and opens the trading socket for the chosen one. */
async function connectAccounts() {
  if (!state.cred || state.connecting) return false;
  state.connecting = true;
  setConnectBusy(true);
  try {
    const data = await derivRest("GET", "/trading/v1/options/accounts");
    const list = (data && Array.isArray(data.data) ? data.data : [])
      .filter((a) => a && a.account_id && a.status !== "inactive")
      .map((a) => ({
        id: String(a.account_id),
        currency: a.currency || "USD",
        balance: Number(a.balance) || 0,
        isVirtual: a.account_type === "demo",
      }));
    if (!list.length) throw new Error("No active Options trading accounts found on this login.");
    state.accounts = list;
    const preferred =
      list.find((a) => a.id === state.activeId) || list.find((a) => a.isVirtual) || list[0];
    await openTradeSocket(preferred);
    closeConnectDialog();
    return true;
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      clearCred();
      showConnectError(
        err.status === 403
          ? "That token lacks the Trade scope — create one with Trade access."
          : "Deriv rejected the token (expired or invalid). Please connect again."
      );
      openConnectDialog();
    } else {
      showConnectError(errText(err));
      openConnectDialog();
    }
    renderAccount();
    return false;
  } finally {
    state.connecting = false;
    setConnectBusy(false);
  }
}

/** Gets a one-time WebSocket URL for `acc` and opens the trading socket on it. */
async function openTradeSocket(acc) {
  if (state.trade) state.trade.close();
  state.account = null;
  state.activeId = acc.id;
  ssSet(ACTIVE_KEY, acc.id);
  renderAccount();

  const otp = await derivRest("POST", "/trading/v1/options/accounts/" + encodeURIComponent(acc.id) + "/otp");
  const url = otp && otp.data && otp.data.url;
  if (!url) throw new Error("Deriv did not return a trading connection URL.");

  await new Promise((resolve, reject) => {
    let settled = false;
    const sock = makeSocket("trade", {
      onOpen: () => {
        settled = true;
        state.tradeRetryDelay = 1000;
        state.account = { ...acc };
        renderAccount();
        renderModeUI();
        sock.request({ balance: 1, subscribe: 1 }).catch(() => {});
        toast("Connected to " + acc.id + " (" + (acc.isVirtual ? "Demo" : "Real") + ")", "success");
        keepPayoutsFresh(); // re-quote in the account currency
        resolve();
      },
      onMessage: onTradeMessage,
      onClose: () => {
        if (!settled) {
          settled = true;
          reject(new Error("Trading connection was refused by Deriv."));
          return;
        }
        onTradeSocketLost(acc);
      },
    });
    state.trade = sock;
    sock.open(url);
  });
}

function onTradeSocketLost(acc) {
  state.account = null;
  renderAccount();
  if (state.running && state.tradeMode === "live") {
    state.running = false;
    renderControls();
    toast("Trading connection lost — live trading stopped.", "error");
  }
  if (!state.cred || state.activeId !== acc.id) return;
  // OTPs are single-use: reconnect with a fresh one after a backoff.
  setTimeout(() => {
    if (!state.cred || state.activeId !== acc.id || (state.trade && state.trade.isBusy())) return;
    openTradeSocket(acc).catch(() => onTradeSocketLost(acc));
  }, state.tradeRetryDelay + Math.random() * 500);
  state.tradeRetryDelay = Math.min(state.tradeRetryDelay * 2, 30000);
}

function onTradeMessage(msg) {
  if (msg.error) return; // request() callers surface their own errors
  if (msg.msg_type === "balance" && msg.balance) onBalance(msg.balance);
  else if (msg.msg_type === "proposal_open_contract" && msg.proposal_open_contract) {
    onProposalOpenContract(msg.proposal_open_contract);
  }
}

function onBalance(b) {
  if (!state.account) return;
  const v = Number(b.balance);
  if (Number.isFinite(v)) state.account.balance = v;
  if (b.currency) state.account.currency = b.currency;
  const listed = state.accounts.find((a) => a.id === state.account.id);
  if (listed) listed.balance = state.account.balance;
  renderAccount();
}

async function connectWithToken() {
  const token = $("token-input").value.trim();
  if (!token) {
    showConnectError("Paste your API token first.");
    return;
  }
  const appInput = $("app-id-input").value.trim();
  if (appInput) saveAppId(appInput);
  if (!getAppId()) {
    showConnectError("API tokens also need your App ID — paste it above (developers.deriv.com → Apps).");
    return;
  }
  showConnectError("");
  setCred({ token, kind: "pat", expiresAt: null });
  const ok = await connectAccounts();
  if (ok) $("token-input").value = "";
}

function switchAccount(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc || id === state.activeId) return;
  // Switching always drops back to Simulate; Live (and real-money arming)
  // must be chosen again deliberately on the new account.
  state.running = false;
  state.tradeMode = "sim";
  state.realArmed = false;
  renderModeUI();
  openTradeSocket(acc).catch((err) => toast("Could not switch: " + errText(err), "error"));
}

function clearCred() {
  state.cred = null;
  ssSet(CRED_KEY, null);
  ssSet(ACTIVE_KEY, null);
  if (state.trade) state.trade.close();
  state.trade = null;
  state.account = null;
  state.accounts = [];
  state.activeId = null;
  state.realArmed = false;
  if (state.tradeMode === "live") {
    state.tradeMode = "sim";
    state.running = false;
  }
}

function disconnect() {
  clearCred();
  renderAccount();
  renderModeUI();
  toast("Disconnected — tokens cleared from this browser.", "info");
}

/* ------------------------------ market stream ---------------------------- */

function onTick(tick) {
  const pip = Number.isFinite(Number(tick.pip_size)) ? Number(tick.pip_size) : 2;
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

  if (!state.running) return;
  if (tick.symbol && tick.symbol !== state.settings.symbol) return;
  if (!passesEntryFilter()) return;
  if (state.tradeMode === "live") placeLiveTrade();
  else settleSimTrade(digit);
}

/**
 * Smart entry — a pacing filter, NOT an edge (ticks are independent, so the
 * odds per trade don't change; it just trades less often).
 *   Differs: skip the tick right after your digit hit.
 *   Matches: only enter after your digit has been absent for 3 ticks.
 */
function passesEntryFilter() {
  if (!state.settings.smartEntry) return true;
  const s = state.settings;
  const prev = (i) => state.trail[i + 1];
  if (s.type === "matches") {
    for (let i = 0; i < 3; i++) {
      const t = prev(i);
      if (t && t.digit === s.digit) return false;
    }
    return true;
  }
  const p = prev(0);
  return !(p && p.digit === s.digit);
}

/* ----------------------------- simulation core --------------------------- */

function settleSimTrade(resultDigit) {
  const s = state.settings;
  const win = s.type === "matches" ? resultDigit === s.digit : resultDigit !== s.digit;
  const m = state.payout.multiplier;
  const pnl = win ? Math.round(s.stake * (m - 1) * 100) / 100 : -s.stake;
  settleShared({ win, stake: s.stake, pnl, mult: win ? m : 0, resultDigit, type: s.type, digit: s.digit, symbol: s.symbol, live: false });
}

/* ------------------------------ live trading ----------------------------- */

function liveArmed() {
  return (
    state.tradeMode === "live" &&
    state.running &&
    !!state.account &&
    !!state.trade &&
    state.trade.isOpen() &&
    (state.account.isVirtual || state.realArmed)
  );
}

/**
 * Buys a REAL 1-tick contract on the active account via "buy with
 * parameters". Settlement arrives through proposal_open_contract.
 */
async function placeLiveTrade() {
  if (!liveArmed()) return;
  if (state.inflightBuys + state.openContracts.size >= MAX_OPEN_CONTRACTS) return;
  const s = state.settings;
  const acc = state.account;
  state.inflightBuys += 1;
  try {
    const res = await state.trade.request({
      buy: "1",
      price: s.stake,
      parameters: {
        amount: s.stake,
        basis: "stake",
        contract_type: s.type === "matches" ? "DIGITMATCH" : "DIGITDIFF",
        currency: acc.currency,
        duration: 1,
        duration_unit: "t",
        underlying_symbol: s.symbol,
        barrier: String(s.digit),
      },
    });
    const b = res.buy || {};
    if (b.contract_id == null) return;
    state.openContracts.set(String(b.contract_id), {
      digit: s.digit,
      type: s.type,
      stake: Number(b.buy_price) || s.stake,
      symbol: s.symbol,
    });
    if (b.balance_after != null) onBalance({ balance: b.balance_after });
    state.trade
      .request({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 }, 60000)
      .then((r) => r && r.proposal_open_contract && onProposalOpenContract(r.proposal_open_contract))
      .catch(() => {});
  } catch (err) {
    toast("Trade rejected: " + errText(err), "error");
    const code = err && err.code ? err.code : "";
    if (code === "InsufficientBalance" || code === "AuthorizationRequired" || code === "PermissionDenied") {
      state.running = false;
      renderControls();
    }
  } finally {
    state.inflightBuys -= 1;
  }
}

function lastDigitOf(v) {
  if (v == null) return null;
  const s = String(v);
  const c = s.charAt(s.length - 1);
  return c >= "0" && c <= "9" ? Number(c) : null;
}

function onProposalOpenContract(poc) {
  if (!poc || poc.contract_id == null) return;
  const key = String(poc.contract_id);
  const meta = state.openContracts.get(key);
  if (!meta || !poc.is_sold) return;
  state.openContracts.delete(key);
  if (poc.subscription && poc.subscription.id && state.trade) {
    state.trade.request({ forget: poc.subscription.id }).catch(() => {});
  }
  const stake = Number(poc.buy_price) || meta.stake;
  const payout = Number(poc.payout);
  const profit = Number(poc.profit);
  const pnl = Number.isFinite(profit) ? profit : (Number(poc.sell_price) || 0) - stake;
  const win = pnl > 0;
  const resultDigit =
    lastDigitOf(poc.exit_tick_display_value) ??
    lastDigitOf(poc.exit_spot_display_value) ??
    lastDigitOf(poc.exit_tick_display) ??
    null;
  settleShared({
    win,
    stake,
    pnl: Math.round(pnl * 100) / 100,
    mult: win && Number.isFinite(payout) && stake > 0 ? payout / stake : 0,
    resultDigit,
    type: meta.type,
    digit: meta.digit,
    symbol: poc.underlying_symbol || meta.symbol,
    live: true,
  });
}

/* --------------------------- shared settlement --------------------------- */

function settleShared(t) {
  const st = state.stats;
  st.trades += 1;
  if (t.win) {
    st.wins += 1;
    st.streak = st.streak >= 0 ? st.streak + 1 : 1;
  } else {
    st.losses += 1;
    st.streak = st.streak <= 0 ? st.streak - 1 : -1;
  }
  st.net = Math.round((st.net + t.pnl) * 100) / 100;

  state.history.unshift({ ...t, time: new Date() });
  if (state.history.length > HISTORY_LIMIT) state.history.pop();

  renderStats();
  renderHistory();
  $("result-announcer").textContent = (t.win ? "Win " : "Loss ") + fmtSigned(t.pnl);
  showResultFlash(t.win, t.mult, t.pnl);
  checkRiskLimits();
}

function checkRiskLimits() {
  const net = state.stats.net;
  const { tp, sl } = state.settings;
  if (tp != null && net >= tp) {
    state.running = false;
    renderControls();
    toast("Take profit reached (" + fmtSigned(net) + ") — stopped.", "success");
  } else if (sl != null && net <= -sl) {
    state.running = false;
    renderControls();
    toast("Stop loss reached (" + fmtSigned(net) + ") — stopped.", "error");
  }
}

/* -------------------------------- formatting ----------------------------- */

const fmtCache = {};

function money(value, currency) {
  const cur = currency || (state.account ? state.account.currency : "USD");
  try {
    if (!fmtCache[cur]) fmtCache[cur] = new Intl.NumberFormat("en-US", { style: "currency", currency: cur });
    return fmtCache[cur].format(value);
  } catch {
    return Number(value).toFixed(2) + " " + cur;
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
  setStatus(state.status);
  renderAccount();
  renderModeUI();
  renderStrategy();
  renderQuote(null);
  renderTrail();
  renderFreq();
  renderPayout();
  renderDigitPayouts();
  renderStats();
  renderHistory();
}

function renderAccount() {
  const acc = state.account;
  const sel = $("account-select");
  const navBtn = $("connect-button-nav");

  if (acc) {
    $("account-empty").hidden = true;
    $("account-live").hidden = false;
    $("balance-value").textContent = money(acc.balance, acc.currency);
    $("balance-currency").textContent = acc.currency;
    $("account-loginid").textContent = acc.id;
    const badge = $("account-type");
    badge.textContent = acc.isVirtual ? "Demo" : "Real";
    badge.className = "badge " + (acc.isVirtual ? "badge-demo" : "badge-real");
    navBtn.textContent = acc.id;
  } else {
    $("account-empty").hidden = false;
    $("account-live").hidden = true;
    navBtn.textContent = state.cred ? "Connecting…" : "Connect";
  }

  if (acc && state.accounts.length > 1) {
    sel.hidden = false;
    sel.textContent = "";
    for (const a of state.accounts) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.id + " · " + (a.isVirtual ? "Demo" : "Real") + " · " + money(a.balance, a.currency);
      sel.appendChild(opt);
    }
    sel.value = acc.id;
  } else {
    sel.hidden = true;
  }
}

function renderModeUI() {
  const acc = state.account;
  const isLive = state.tradeMode === "live";
  const isReal = isLive && acc && !acc.isVirtual;
  const badge = $("mode-badge");

  $("trade-mode-sim").setAttribute("aria-pressed", String(!isLive));
  $("trade-mode-live").setAttribute("aria-pressed", String(isLive));

  if (isLive) {
    badge.textContent = isReal ? "Live · Real money" : "Live · Demo";
    badge.className = "badge " + (isReal ? "badge-live-red" : "badge-live-blue");
    $("shield-text").textContent = isReal ? "REAL MONEY · " + acc.id : "Live trading · DEMO account";
  } else {
    badge.textContent = "Simulation";
    badge.className = "badge badge-sim";
    $("shield-text").textContent = "Simulate mode — no real trades";
  }
  renderControls();
}

function renderControls() {
  const startBtn = $("start-simulation-btn");
  startBtn.disabled = state.running;
  $("stop-simulation-btn").disabled = !state.running;
  $("running-indicator").hidden = !state.running;
  if (state.tradeMode === "live") {
    startBtn.textContent = state.account && !state.account.isVirtual ? "Start LIVE trading" : "Start live (demo)";
  } else {
    startBtn.textContent = "Start simulation";
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
      : state.pub && state.pub.isOpen()
        ? "Waiting for the first tick…"
        : "Connecting to Deriv…";
    return;
  }
  main.textContent = entry.quoteStr.slice(0, -1);
  digitEl.textContent = entry.digit;
  meta.textContent =
    symbolName(state.settings.symbol) + " · " + fmtClock(new Date(entry.epoch * 1000)) + (state.demoFeed ? " · synthetic demo feed" : " · live");
  digitEl.classList.remove("flash");
  void digitEl.offsetWidth;
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
  const total = state.freqQueue.length;
  for (let d = 0; d <= 9; d++) {
    const col = document.createElement("div");
    col.className = "freq-col" + (d === state.settings.digit ? " selected" : "");
    const track = document.createElement("div");
    track.className = "freq-track";
    const bar = document.createElement("div");
    bar.className = "freq-bar";
    bar.style.height = (state.freq[d] / max) * 100 + "%";
    track.appendChild(bar);
    const label = document.createElement("span");
    label.className = "freq-label";
    label.textContent = String(d);
    const pct = total ? Math.round((state.freq[d] / total) * 100) : 0;
    col.title = d + ": " + state.freq[d] + " of the last " + total + " ticks (" + pct + "%)";
    col.append(track, label);
    wrap.appendChild(col);
  }
}

function renderStrategy() {
  const isMatches = state.settings.type === "matches";
  $("trade-type-matches").setAttribute("aria-pressed", String(isMatches));
  $("trade-type-differs").setAttribute("aria-pressed", String(!isMatches));
  $("trade-type-description").textContent = isMatches
    ? "Wins when the last digit EQUALS your digit. Rare (~10%) but pays about 8–9×."
    : "Wins when the last digit is ANYTHING BUT your digit. Frequent (~90%) but pays about 1.1×.";
  for (const btn of document.querySelectorAll(".digit")) {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.digit) === state.settings.digit));
  }
  const stakeInput = $("stake-input");
  if (document.activeElement !== stakeInput) stakeInput.value = state.settings.stake.toFixed(2);
  const tpInput = $("take-profit-input");
  if (document.activeElement !== tpInput) tpInput.value = state.settings.tp != null ? state.settings.tp : "";
  const slInput = $("stop-loss-input");
  if (document.activeElement !== slInput) slInput.value = state.settings.sl != null ? state.settings.sl : "";
  $("smart-entry-toggle").checked = !!state.settings.smartEntry;
}

function renderPayout() {
  const s = state.settings;
  const liveV = state.digitPayouts[s.digit];
  const m = liveV != null ? liveV : FALLBACK_PAYOUTS[s.type];
  state.payout = { multiplier: m, source: liveV != null ? "live" : "estimate" };
  $("payout-mult").textContent = (liveV != null ? "" : "≈") + m.toFixed(2) + "×";
  $("payout-detail").textContent =
    (liveV != null ? "Live quote" : "Estimate") + " — win returns " + money(Math.round(s.stake * m * 100) / 100) + " · risk " + money(s.stake);
}

function renderDigitPayouts() {
  for (let d = 0; d <= 9; d++) {
    const el = document.querySelector('[data-digit-pay="' + d + '"]');
    if (!el) continue;
    const v = state.digitPayouts[d];
    el.textContent = (v != null ? "" : "≈") + (v != null ? v : FALLBACK_PAYOUTS[state.settings.type]).toFixed(2) + "×";
    el.classList.toggle("live", v != null);
  }
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
  body.textContent = "";
  $("trade-history-empty").hidden = state.history.length > 0;
  for (const t of state.history) {
    const tr = document.createElement("tr");
    const cells = [
      fmtClock(t.time),
      t.live ? "Live" : "Sim",
      t.symbol,
      (t.type === "matches" ? "Matches " : "Differs ") + t.digit,
      t.digit + " → " + (t.resultDigit == null ? "?" : t.resultDigit),
      money(t.stake),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    const tdPnl = document.createElement("td");
    tdPnl.textContent = fmtSigned(t.pnl);
    tdPnl.className = t.pnl >= 0 ? "pl-pos" : "pl-neg";
    const tdRes = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + (t.win ? "badge-win" : "badge-loss");
    badge.textContent = t.win ? "Win" : "Loss";
    tdRes.appendChild(badge);
    tr.append(tdPnl, tdRes);
    body.appendChild(tr);
  }
}

let flashTimer = null;

/** Big multiplier burst over the digit matrix on every settled trade. */
function showResultFlash(win, mult, pnl) {
  const el = $("result-flash");
  el.className = "result-flash " + (win ? "win" : "loss") + (win && mult >= 5 ? " big" : "");
  el.textContent = "";
  const m = document.createElement("span");
  m.className = "rf-mult";
  m.textContent = "×" + (Number(mult) > 0 ? Number(mult).toFixed(2) : "0.00");
  const txt = document.createElement("span");
  txt.className = "rf-txt";
  txt.textContent = (win ? "WIN " : "LOSS ") + fmtSigned(pnl);
  el.append(m, txt);
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.hidden = true;
  }, 1400);
}

/* ----------------------------- dialogs + toasts -------------------------- */

function openConnectDialog() {
  $("oauth-block").hidden = !oauthAvailable();
  const appInput = $("app-id-input");
  if (document.activeElement !== appInput) appInput.value = getAppId();
  const dialog = $("connect-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeConnectDialog() {
  const dialog = $("connect-dialog");
  if (dialog.open) dialog.close();
  showConnectError("");
}

function showConnectError(message) {
  const el = $("connect-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function setConnectBusy(busy) {
  const btn = $("token-connect-button");
  btn.disabled = busy;
  btn.textContent = busy ? "Connecting…" : "Connect";
  renderAccount();
}

function saveAppId(v) {
  try {
    if (v) localStorage.setItem(APPID_KEY, v);
    else localStorage.removeItem(APPID_KEY);
  } catch {
    /* ignore */
  }
  $("oauth-block").hidden = !oauthAvailable();
}

function openArmDialog() {
  $("arm-loginid").textContent = state.account ? state.account.id : "";
  $("arm-confirm-checkbox").checked = false;
  $("arm-enable-button").disabled = true;
  const dialog = $("arm-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeArmDialog() {
  const dialog = $("arm-dialog");
  if (dialog.open) dialog.close();
}

function toast(message, kind) {
  const container = $("toast-container");
  const el = document.createElement("div");
  el.className = "toast " + (kind || "info");
  el.textContent = message;
  container.appendChild(el);
  while (container.children.length > 3) container.removeChild(container.firstChild);
  setTimeout(() => el.remove(), 3600);
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
  renderDigitPayouts();
  keepPayoutsFresh();
}

function selectDigit(digit) {
  if (state.settings.digit === digit) return;
  state.settings.digit = digit;
  saveSettings();
  renderStrategy();
  renderTrail();
  renderFreq();
  renderPayout();
}

function setStake(value) {
  state.settings.stake = clampStake(Number(value));
  saveSettings();
  renderStrategy();
  renderPayout();
  keepPayoutsFresh();
}

function setTradeMode(mode) {
  if (mode === "live") {
    if (!state.account) {
      toast("Connect your Deriv account first — pick Demo to trade virtual funds.", "info");
      openConnectDialog();
      return;
    }
    if (!state.account.isVirtual && !state.realArmed) {
      openArmDialog();
      return;
    }
    state.tradeMode = "live";
    toast(
      state.account.isVirtual ? "Live trading on DEMO " + state.account.id : "REAL-money trading armed on " + state.account.id,
      state.account.isVirtual ? "success" : "error"
    );
  } else {
    state.tradeMode = "sim";
    state.running = false;
    toast("Simulate mode — nothing is sent to Deriv.", "info");
  }
  renderModeUI();
}

function startRun() {
  if (state.running) return;
  if (state.tradeMode === "live" && !liveReady()) return;
  state.running = true;
  renderControls();
}

function liveReady() {
  if (!state.account || !state.trade || !state.trade.isOpen()) {
    toast("Live trading needs your connected account — reconnecting…", "error");
    openConnectDialog();
    return false;
  }
  if (!state.account.isVirtual && !state.realArmed) {
    openArmDialog();
    return false;
  }
  return true;
}

function stopRun() {
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
    keepPayoutsFresh();
  });

  $("trade-mode-sim").addEventListener("click", () => setTradeMode("sim"));
  $("trade-mode-live").addEventListener("click", () => setTradeMode("live"));
  $("account-select").addEventListener("change", (e) => switchAccount(e.target.value));

  $("trade-type-matches").addEventListener("click", () => setTradeType("matches"));
  $("trade-type-differs").addEventListener("click", () => setTradeType("differs"));
  for (const btn of document.querySelectorAll(".digit")) {
    btn.addEventListener("click", () => selectDigit(Number(btn.dataset.digit)));
  }

  $("stake-input").addEventListener("change", (e) => setStake(e.target.value));
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => setStake(chip.dataset.stake));
  }
  $("take-profit-input").addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    state.settings.tp = Number.isFinite(v) && v > 0 ? v : null;
    saveSettings();
  });
  $("stop-loss-input").addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    state.settings.sl = Number.isFinite(v) && v > 0 ? v : null;
    saveSettings();
  });
  $("smart-entry-toggle").addEventListener("change", (e) => {
    state.settings.smartEntry = e.target.checked;
    saveSettings();
  });

  $("start-simulation-btn").addEventListener("click", startRun);
  $("stop-simulation-btn").addEventListener("click", stopRun);
  $("reset-stats-btn").addEventListener("click", resetSession);

  $("connect-button").addEventListener("click", openConnectDialog);
  $("connect-button-nav").addEventListener("click", openConnectDialog);
  $("oauth-connect-button").addEventListener("click", startOAuth);
  $("app-id-input").addEventListener("change", (e) => saveAppId(e.target.value.trim()));
  $("token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectWithToken();
  });
  $("connect-cancel-button").addEventListener("click", closeConnectDialog);
  $("disconnect-button").addEventListener("click", disconnect);
  $("connect-dialog").addEventListener("click", (e) => {
    if (e.target === $("connect-dialog")) closeConnectDialog();
  });

  $("arm-confirm-checkbox").addEventListener("change", (e) => {
    $("arm-enable-button").disabled = !e.target.checked;
  });
  $("arm-enable-button").addEventListener("click", () => {
    state.realArmed = true;
    closeArmDialog();
    setTradeMode("live");
  });
  $("arm-cancel-button").addEventListener("click", closeArmDialog);
  $("arm-dialog").addEventListener("click", (e) => {
    if (e.target === $("arm-dialog")) closeArmDialog();
  });

  document.addEventListener("keydown", (e) => {
    if ($("connect-dialog").open || $("arm-dialog").open) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (/^[0-9]$/.test(e.key)) selectDigit(Number(e.key));
    else if (e.key === "ArrowRight") selectDigit((state.settings.digit + 1) % 10);
    else if (e.key === "ArrowLeft") selectDigit((state.settings.digit + 9) % 10);
  });
}

/* ---------------------------------- init --------------------------------- */

async function init() {
  loadSettings();
  loadCred();
  bindEvents();
  renderAll();
  await loadConfig();
  renderAll();
  connectPublic();
  const handled = await handleOAuthReturn();
  if (!handled && state.cred) connectAccounts();
}

init();
