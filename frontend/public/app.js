/* ==========================================================================
 * Deriv Edge Lab — app.js  (vanilla JS, no build step)
 *
 * TWO EXPLICIT MODES
 *   Research simulation — public Deriv ticks + separate VIRTUAL results.
 *   Deriv Demo execution — explicit opt-in; backend verifies the Demo account,
 *     obtains authenticated quotes and places/monitors actual Demo contracts.
 *     Credentials stay server-side; this browser never sends buy/sell messages.
 *     Live accounts are blocked independently by the backend.
 *
 * Simulation rules (one open virtual contract at a time, no duplicates):
 *   Differs     — opened on tick T, settled on tick T+1. Win if T+1's last
 *                 digit ≠ chosen digit. Profit = Deriv's live payout − stake.
 *                 Loss = stake.
 *   Accumulator — value grows by growth% each tick while |Δprice/prev| stays
 *                 below Deriv's live barrier; knocked out → loss = stake.
 *                 Closes at the profit target or Deriv's maximum ticks.
 *   Multiplier  — P/L = stake × multiplier × move% − Deriv commission;
 *                 stop-out at −stake (loss never exceeds stake); closes at
 *                 +10% of stake (background take-profit) or after
 *                 MULT_MAX_TICKS ticks at market.
 * Background safeguards: per-contract take-profit (10% of stake), a hard
 * cap of MAX_TRADES per session, and the total loss limit is never
 * exceeded (a contract whose full loss would breach it is not opened).
 * ========================================================================== */

"use strict";

const $ = (id) => document.getElementById(id);

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

const DIFFERS_FALLBACK = 1.09; // only until live quotes arrive (labelled "≈")
const ACCU_FALLBACK = { 0.01: 0.0009, 0.02: 0.0007, 0.03: 0.000537, 0.04: 0.00045, 0.05: 0.0004 };
const MULT_COMMISSION_FALLBACK = 0.00036; // fraction of stake × multiplier
const MULT_MAX_TICKS = 120;
const MAX_TRADES = 1000; // background safeguard
const CONTRACT_TP_PCT = 0.1; // background per-contract take-profit (accu / mult)
/* Deriv multiplier values allowed per Volatility index. */
const MULTS = {
  R_10: [400, 1000, 2000, 3000, 4000], "1HZ10V": [400, 1000, 2000, 3000, 4000],
  R_25: [160, 400, 800, 1200, 1600], "1HZ25V": [160, 400, 800, 1200, 1600],
  R_50: [80, 200, 400, 600, 800], "1HZ50V": [80, 200, 400, 600, 800],
  R_75: [50, 100, 200, 300, 500], "1HZ75V": [50, 100, 200, 300, 500],
  R_100: [40, 100, 200, 300, 400], "1HZ100V": [40, 100, 200, 300, 400],
};
const multsFor = (sym) => MULTS[sym] || MULTS.R_100;
const HISTORY_LIMIT = 500;
const TICK_TRAIL = 10;
const FREQ_WINDOW = 100;
const STAKE_MIN = { differs: 0.35, accu: 1, mult: 1 };
const STAKE_MAX = { differs: 5000, accu: 200, mult: 500 };

const CRED_KEY = "del.cred";
const ACTIVE_KEY = "del.activeAccount";
const PKCE_KEY = "del.pkce";
const SETTINGS_KEY = "del.settings.v4";

/* --------------------------------- state --------------------------------- */

const state = {
  cfg: { ...DEFAULT_CONFIG },
  pub: null,
  trade: null,
  status: "connecting",
  feedAttempts: 0,
  demoFeed: false,
  demoTimer: null,
  cred: null,
  accounts: [],
  linkedAccounts: [],
  linkedAccountsTime: null,
  linkedAccountsError: null,
  account: null,
  activeId: null,
  owner: null,
  connecting: false,
  execution: "simulation",
  demo: null,
  csrf: null,
  demoBusy: false,
  demoHalted: false,
  demoRunId: null,
  accountPoll: null,
  sessionView: null,
  snapshotRevision: 0,
  tradeRetryDelay: 1000,
  settings: {
    symbol: "R_100", product: "differs", digit: 5, autoDigit: false, stake: 1, entryFilter: false,
    growth: 0.03, mult: 100, dir: "up", contractTp: 0.1, target: null, maxLoss: null, maxTrades: MAX_TRADES, sound: true,
  },
  trail: [],
  freq: new Array(10).fill(0),
  freqQueue: [],
  prices: [], // recent prices (for entry filters)
  lastPip: 2,
  lastTick: null,
  tickSubscriptionGen: 0,
  digitPayouts: new Array(10).fill(null),
  payoutReqs: new Map(),
  payoutGen: 0,
  accuInfo: {}, // growth -> { barrier, maxTicks } from live proposals
  multCommission: {}, // multiplier -> fraction
  session: "idle", // idle | running | paused | done
  pos: null, // open virtual contract
  stats: null,
  history: [],
  seq: 0,
};

function freshStats() {
  return { trades: 0, wins: 0, losses: 0, breakEven: 0, unresolved: 0, net: 0, sumWin: 0, sumLoss: 0, peak: 0, maxDD: 0 };
}
state.stats = freshStats();

/* ------------------------------ persistence ------------------------------ */

function num(v, min) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : null;
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!s) return;
    const t = state.settings;
    if (SYMBOLS.some((x) => x[0] === s.symbol)) t.symbol = s.symbol;
    if (["differs", "accu", "mult"].includes(s.product)) t.product = s.product;
    if (Number.isInteger(s.digit) && s.digit >= 0 && s.digit <= 9) t.digit = s.digit;
    if ([0.01, 0.02, 0.03, 0.04, 0.05].includes(s.growth)) t.growth = s.growth;
    if (multsFor(t.symbol).includes(s.mult)) t.mult = s.mult;
    if (s.dir === "up" || s.dir === "down") t.dir = s.dir;
    t.stake = num(s.stake, 0.35) || 1;
    t.target = num(s.target, 0.01);
    t.maxLoss = num(s.maxLoss, 0.01);
  } catch {
    /* defaults stand */
  }
  clampStakeToProduct();
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* ignore */
  }
}

function clampStakeToProduct() {
  const p = state.settings.product;
  const v = Math.round(state.settings.stake * 100) / 100;
  state.settings.stake = Math.min(STAKE_MAX[p], Math.max(STAKE_MIN[p], v));
  const allowed = multsFor(state.settings.symbol);
  if (!allowed.includes(state.settings.mult)) state.settings.mult = allowed[1];
  state.settings.contractTp = Math.max(0.1, Math.round(state.settings.stake * CONTRACT_TP_PCT * 100) / 100);
}

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

/* --------------------------------- config -------------------------------- */

const CONFIG_RETRY_DELAYS = [5000, 10000, 15000, 20000];
let configRetryTimer = null;

async function loadConfig(attempt = 0) {
  let timer;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/api/deriv/config", { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error("config-unavailable");
    const d = await res.json();
    if (!d || typeof d.oauth_ready !== "boolean") throw new Error("invalid-config");
    if (d.app_id && d.app_id !== "1089") state.cfg.app_id = String(d.app_id);
    if (d.public_ws_url) state.cfg.public_ws_url = d.public_ws_url;
    if (d.api_base) state.cfg.api_base = d.api_base;
    if (d.oauth_authorize_url) state.cfg.oauth_authorize_url = d.oauth_authorize_url;
    state.cfg.oauth_ready = !!d.oauth_ready;
    state.cfg.demo_execution_enabled = d.demo_execution_enabled === true;
    clearTimeout(configRetryTimer);
    configRetryTimer = null;
    // A Free backend can wake after the user has already opened the connection dialog.
    $("oauth-block").hidden = !state.cfg.oauth_ready;
  } catch {
    // Retry in the background so a sleeping backend never blocks public market data.
    if (attempt < CONFIG_RETRY_DELAYS.length) {
      configRetryTimer = setTimeout(() => loadConfig(attempt + 1), CONFIG_RETRY_DELAYS[attempt]);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- generic socket ----------------------------- */

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

/* --------------------------- public market socket ------------------------ */

let pubRetryDelay = 1000;

function setStatus(status) {
  state.status = status;
  const dot = $("status-dot");
  dot.className = "dot " + (status === "live" ? "dot-live" : "dot-warn");
  $("connection-status-text").textContent =
    status === "live" ? "Live · " + state.settings.symbol
      : status === "demo" ? "Demo feed · " + state.settings.symbol
        : status === "reconnecting" ? "Reconnecting…" : "Connecting…";
  renderControls();
}

function connectPublic() {
  if (state.pub && state.pub.isBusy()) return;
  setStatus(state.demoFeed ? "demo" : state.pub ? "reconnecting" : "connecting");
  if (!state.pub) {
    state.pub = makeSocket({
      onOpen: () => {
        pubRetryDelay = 1000;
        state.feedAttempts = 0;
        stopDemoTimer();
        setStatus("live");
        subscribeTicks(state.settings.symbol);
        refreshQuotes();
      },
      onMessage: (msg) => {
        if (msg.error) return;
        if (msg.msg_type === "tick" && msg.tick) onTick(msg.tick);
        else if (msg.msg_type === "proposal" && msg.proposal && state.payoutReqs.has(msg.req_id)) applyDigitProposal(msg.req_id, msg.proposal);
      },
      onClose: () => {
        interruptSimulation("Live feed disconnected; the contract's outcome cannot be verified.");
        resetFeedState();
        state.feedAttempts += 1;
        if (state.feedAttempts >= 3 || state.demoFeed) {
          if (!state.demoFeed) startDemoTimer(state.settings.symbol, true);
          setStatus("demo");
        } else setStatus("reconnecting");
        setTimeout(connectPublic, pubRetryDelay + Math.random() * 400);
        pubRetryDelay = Math.min(pubRetryDelay * 2, 30000);
      },
    });
  }
  state.pub.open(state.cfg.public_ws_url);
}

function resetFeedState() {
  state.trail = [];
  state.freq = new Array(10).fill(0);
  state.freqQueue = [];
  state.prices = [];
  state.lastTick = null;
  renderTrail();
  renderFreq();
  renderQuote(null);
}

async function subscribeTicks(symbol) {
  if (state.pos) {
    toast("Wait for the open virtual contract to finish before changing markets.", "info");
    return;
  }
  if (state.demoFeed) return startDemoTimer(symbol, false);
  if (!state.pub || !state.pub.isOpen()) return;
  const gen = ++state.tickSubscriptionGen;
  resetFeedState();
  renderControls();
  await state.pub.request({ forget_all: "ticks" }, 10000).catch(() => {});
  if (gen !== state.tickSubscriptionGen || symbol !== state.settings.symbol || !state.pub.isOpen()) return;
  setStatus("live");
  try {
    await state.pub.request({ ticks: symbol, subscribe: 1 });
  } catch (err) {
    toast("Could not subscribe to " + symbol + ": " + errText(err), "error");
  }
}

/* Labelled synthetic feed — ONLY when Deriv's public gateway is unreachable. */
function startDemoTimer(symbol, announce) {
  interruptSimulation("Synthetic display feed started; research requires verified live ticks.");
  stopDemoTimer();
  state.demoFeed = true;
  resetFeedState();
  setStatus("demo");
  if (announce) toast("Deriv is unreachable from this network — showing a labelled demo feed until it's back.", "info");
  let price = 572.26;
  state.demoTimer = setInterval(() => {
    price *= 1 + (Math.random() - 0.5) * 0.0016;
    onTick({ quote: price, pip_size: 2, epoch: Math.floor(Date.now() / 1000), symbol }, true);
  }, symbol.startsWith("1HZ") ? 1000 : 2000);
}

function stopDemoTimer() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
  state.demoFeed = false;
}

/* ---------------------- live Deriv quotes (no purchases) ----------------- */

let quoteDebounce = null;

function refreshQuotes() {
  clearTimeout(quoteDebounce);
  quoteDebounce = setTimeout(() => {
    subscribeDigitPayouts();
    fetchContractInfo();
  }, 400);
}

/** Live Differs quote for every digit — proposals are price quotes only. */
async function subscribeDigitPayouts() {
  const gen = ++state.payoutGen;
  state.digitPayouts = new Array(10).fill(null);
  renderDigitPayouts();
  renderTicket();
  const pub = state.pub;
  if (state.demoFeed || !pub || !pub.isOpen()) return;
  await pub.request({ forget_all: "proposal" }, 10000).catch(() => {});
  if (gen !== state.payoutGen) return;
  state.payoutReqs.clear();
  const stake = Math.max(STAKE_MIN.differs, Math.min(STAKE_MAX.differs, state.settings.stake));
  for (let d = 0; d <= 9; d++) {
    if (gen !== state.payoutGen || !pub.isOpen()) return;
    try {
      const res = await pub.request({
        proposal: 1, amount: stake, basis: "stake", contract_type: "DIGITDIFF", currency: "USD",
        duration: 1, duration_unit: "t", underlying_symbol: state.settings.symbol, barrier: String(d), subscribe: 1,
      });
      if (gen !== state.payoutGen) return;
      state.payoutReqs.set(res.req_id, d);
      if (res.proposal) applyDigitProposal(res.req_id, res.proposal);
    } catch (err) {
      if (String((err && err.code) || "").startsWith("RateLimit")) return;
    }
  }
}

function applyDigitProposal(reqId, p) {
  const d = state.payoutReqs.get(reqId);
  if (d == null) return;
  const payout = Number(p.payout);
  const ask = Number(p.ask_price);
  if (payout > 0 && ask > 0) state.digitPayouts[d] = payout / ask;
  renderDigitPayouts();
  if (d === state.settings.digit) renderTicket();
}

/** One-shot quotes for the Accumulator barrier / Multiplier commission. */
async function fetchContractInfo() {
  const pub = state.pub;
  const s = state.settings;
  if (state.demoFeed || !pub || !pub.isOpen()) return;
  const base = { proposal: 1, amount: 10, basis: "stake", currency: "USD", underlying_symbol: s.symbol };
  try {
    const r = await pub.request({ ...base, contract_type: "ACCU", growth_rate: s.growth });
    const cd = (r.proposal && r.proposal.contract_details) || {};
    if (Number(cd.tick_size_barrier) > 0) {
      state.accuInfo[s.symbol + ":" + s.growth] = { barrier: Number(cd.tick_size_barrier), maxTicks: Number(cd.maximum_ticks) || 230 };
    }
  } catch {
    /* fallback barrier stays */
  }
  try {
    const r = await pub.request({ ...base, contract_type: "MULTUP", multiplier: s.mult });
    const c = Number(r.proposal && r.proposal.commission);
    if (c > 0) state.multCommission[s.symbol + ":" + s.mult] = c / (10 * s.mult);
  } catch {
    /* fallback commission stays */
  }
  renderTicket();
}

function differsMultiplier(digit) {
  const v = state.digitPayouts[digit];
  return v != null ? { m: v, live: true } : { m: DIFFERS_FALLBACK, live: false };
}

function accuParams() {
  const s = state.settings;
  const info = state.accuInfo[s.symbol + ":" + s.growth];
  return info ? { ...info, live: true } : { barrier: ACCU_FALLBACK[s.growth], maxTicks: 230, live: false };
}

function multCommissionRate() {
  const s = state.settings;
  const v = state.multCommission[s.symbol + ":" + s.mult];
  return v != null ? { rate: v, live: true } : { rate: MULT_COMMISSION_FALLBACK, live: false };
}

/* ======================= SIMULATION ENGINE (pure) ======================== */

/** cfg = { product, stake, digit, m, growth, barrier, maxTicks, mult, dir, commRate, tp } */
function openContract(cfg, entryPrice) {
  const pos = { ...cfg, entry: entryPrice, prev: entryPrice, ticks: 0, value: cfg.stake };
  if (cfg.product === "mult") pos.commission = Math.round(cfg.stake * cfg.mult * cfg.commRate * 100) / 100;
  return pos;
}

/** Advances an open contract by one tick. Returns null (still open) or a settlement. */
function stepContract(pos, price, digit) {
  const r2 = (v) => Math.round(v * 100) / 100;
  if (pos.product === "differs") {
    const win = digit !== pos.digit;
    const pnl = win ? r2(pos.stake * pos.m - pos.stake) : -pos.stake;
    return { win, pnl, detail: "avoid " + pos.digit + " → " + digit };
  }
  if (pos.product === "accu") {
    const move = Math.abs(price - pos.prev) / pos.prev;
    pos.prev = price;
    if (move >= pos.barrier) return { win: false, pnl: -pos.stake, detail: "knocked out after " + pos.ticks + " ticks" };
    pos.ticks += 1;
    pos.value = pos.value * (1 + pos.growth);
    const profit = r2(pos.value - pos.stake);
    if (profit >= pos.tp) return { win: true, pnl: profit, detail: "target hit after " + pos.ticks + " ticks" };
    if (pos.ticks >= pos.maxTicks) return { win: profit > 0, pnl: profit, detail: "max " + pos.maxTicks + " ticks" };
    return null;
  }
  // multiplier
  pos.ticks += 1;
  const sign = pos.dir === "up" ? 1 : -1;
  const pnl = r2(pos.stake * pos.mult * sign * (price - pos.entry) / pos.entry - pos.commission);
  pos.value = pos.stake + pnl;
  if (pnl <= -pos.stake) return { win: false, pnl: -pos.stake, detail: "stop-out after " + pos.ticks + " ticks" };
  if (pnl >= pos.tp) return { win: true, pnl, detail: "target hit after " + pos.ticks + " ticks" };
  if (pos.ticks >= MULT_MAX_TICKS) return { win: pnl > 0, pnl, detail: "closed at market (" + MULT_MAX_TICKS + " ticks)" };
  return null;
}

function lastDigit(price, pip) {
  const s = Number(price).toFixed(pip);
  return Number(s.charAt(s.length - 1));
}

function coldestDigit(digits) {
  const c = new Array(10).fill(0);
  for (const d of digits) c[d] += 1;
  let best = 0;
  for (let d = 1; d <= 9; d++) if (c[d] < c[best]) best = d;
  return best;
}

/**
 * Statistical entry filters — tested in the comparison tool; none is an edge by itself.
 *   Differs: skip the tick right after your digit appeared.
 *   Accumulator: enter only after 5 calm ticks (each move < half the barrier).
 *   Multiplier: enter only when the last-20-tick move agrees with your direction.
 */
function entryAllowed(product, prices, digits, cfg) {
  const n = prices.length;
  if (product === "differs") return !(digits.length && digits[digits.length - 1] === cfg.digit);
  if (product === "accu") {
    if (n < 6) return false;
    for (let i = n - 5; i < n; i++) if (Math.abs(prices[i] - prices[i - 1]) / prices[i - 1] >= cfg.barrier / 2) return false;
    return true;
  }
  if (n < 21) return false;
  const up = prices[n - 1] > prices[n - 21];
  return cfg.dir === "up" ? up : !up;
}

/* ========================= live research session ========================= */

function currentCfg() {
  const s = state.settings;
  const cfg = { product: s.product, stake: s.stake, tp: s.contractTp };
  if (s.product === "differs") {
    const digit = s.autoDigit && state.freqQueue.length >= 30 ? coldestDigit(state.freqQueue) : s.digit;
    Object.assign(cfg, { digit, m: differsMultiplier(digit).m });
  } else if (s.product === "accu") {
    Object.assign(cfg, { growth: s.growth }, accuParams());
  } else {
    Object.assign(cfg, { mult: s.mult, dir: s.dir, commRate: multCommissionRate().rate });
  }
  return cfg;
}

function liveSimulationReady() {
  return !state.demoFeed && state.status === "live" && !!state.lastTick && state.lastTick.symbol === state.settings.symbol;
}

function onTick(tick, synthetic = false) {
  if (!tick || tick.symbol !== state.settings.symbol) return;
  // Number() also coerces booleans, arrays and blank strings; those are not market data.
  if (![tick.quote, tick.pip_size, tick.epoch].every((v) =>
    typeof v === "number" || (typeof v === "string" && v.trim() !== ""))) return;
  const pip = Number(tick.pip_size);
  const price = Number(tick.quote);
  const epoch = Number(tick.epoch);
  if (tick.pip_size == null || !Number.isInteger(pip) || pip < 0 || pip > 20 ||
      !Number.isFinite(price) || price <= 0 || !Number.isInteger(epoch) || epoch <= 0) return;
  if (synthetic ? !state.demoFeed : state.demoFeed || state.status !== "live") return;
  if (!synthetic && state.lastTick) {
    if (epoch <= state.lastTick.epoch) return; // duplicate or delayed/out-of-order tick
    const interval = tick.symbol.startsWith("1HZ") ? 1 : 2;
    if (epoch - state.lastTick.epoch > interval) {
      interruptSimulation("Missing live ticks; the contract's outcome cannot be verified.");
      resetFeedState();
    }
  }
  const quoteStr = price.toFixed(pip);
  const digit = Number(quoteStr.charAt(quoteStr.length - 1));
  state.trail.unshift({ quoteStr, digit, epoch });
  if (state.trail.length > TICK_TRAIL) state.trail.pop();
  renderQuote({ quoteStr, digit, epoch });
  renderTrail();
  // The fallback remains a labelled display only, never research observations or settlements.
  if (synthetic) return;
  state.lastPip = pip;
  state.lastTick = { symbol: tick.symbol, epoch };
  state.freq[digit] += 1;
  state.freqQueue.push(digit);
  if (state.freqQueue.length > FREQ_WINDOW) state.freq[state.freqQueue.shift()] -= 1;
  state.prices.push(price);
  if (state.prices.length > 200) state.prices.shift();
  renderFreq();
  renderDigitExplain();
  simulateTick(price, digit);
  renderControls();
}

function simulateTick(price, digit) {
  if (!liveSimulationReady()) return;
  if (state.execution === "demo") {
    if (state.session === "running" && !state.demoHalted) void demoSignal();
    return;
  }
  if (state.pos) {
    const res = stepContract(state.pos, price, digit);
    if (res) settle(res);
    else {
      markDrawdown(state.stats, openPnl(state.pos));
      renderStats();
      renderLastTrade();
    }
    return; // never open a new contract on the tick that settled one
  }
  if (state.session !== "running") return;
  if (checkSessionLimits()) return;
  const cfg = currentCfg();
  const { maxLoss } = state.settings;
  if (maxLoss != null && state.stats.net - cfg.stake < -maxLoss - 1e-9) {
    state.session = "done";
    renderControls();
    toast("Total loss limit: another full-stake loss would exceed " + money(maxLoss) + " — session stopped.", "info");
    return;
  }
  if (state.settings.entryFilter && !entryAllowed(cfg.product, state.prices, state.freqQueue, cfg)) return;
  if (cfg.product === "differs" && state.settings.autoDigit && cfg.digit !== state.settings.digit) {
    state.settings.digit = cfg.digit;
    renderStrategy();
  }
  state.pos = openContract(cfg, price);
  state.pos.symbol = state.settings.symbol;
  state.pos.openedAt = new Date();
  markDrawdown(state.stats, openPnl(state.pos));
  renderStats();
  renderLastTrade();
  renderControls();
}

// Statistics only: these helpers do not change the contract pricing/settlement formulas.
function openPnl(pos) {
  const pnl = pos.product === "mult" && pos.ticks === 0 ? -pos.commission : pos.value - pos.stake;
  return Math.round(Math.max(-pos.stake, pnl) * 100) / 100;
}

function markDrawdown(st, unrealized = 0) {
  const equity = Math.round((st.net + unrealized) * 100) / 100;
  st.peak = Math.max(st.peak, equity);
  st.maxDD = Math.max(st.maxDD, Math.round((st.peak - equity) * 100) / 100);
}

function recordSettlement(st, res) {
  st.trades += 1;
  if (res.pnl > 0) {
    st.wins += 1;
    st.sumWin += res.pnl;
  } else if (res.pnl < 0) {
    st.losses += 1;
    st.sumLoss += res.pnl;
  } else st.breakEven += 1;
  st.net = Math.round((st.net + res.pnl) * 100) / 100;
  markDrawdown(st);
}

function appendHistory(pos, res) {
  state.history.unshift({
    n: ++state.seq, time: new Date(), symbol: pos.symbol, product: pos.product,
    label: contractLabel(pos), detail: res.detail, stake: pos.stake, pnl: res.pnl, win: res.win,
    outcome: res.outcome, cum: state.stats.net, digit: pos.digit,
  });
  if (state.history.length > HISTORY_LIMIT) state.history.pop();
  state.lastResult = { pos, res };
}

function settle(res) {
  const pos = state.pos;
  if (!pos) return;
  state.pos = null;
  res = { ...res, win: res.pnl > 0, outcome: res.pnl > 0 ? "win" : res.pnl < 0 ? "loss" : "break-even" };
  recordSettlement(state.stats, res);
  appendHistory(pos, res);
  renderStats();
  renderHistory();
  renderLastTrade();
  showResultFlash(res.win, pos.stake, res.pnl);
  if (res.pnl !== 0) playResultSound(res.win);
  checkSessionLimits();
  renderControls();
}

function contractLabel(pos) {
  if (pos.product === "differs") return "Differs " + pos.digit + " · " + pos.m.toFixed(3) + "×";
  if (pos.product === "accu") return "Accumulator " + Math.round(pos.growth * 100) + "%";
  return "Multiplier ×" + pos.mult + " " + (pos.dir === "up" ? "Up" : "Down");
}

function checkSessionLimits() {
  const { target, maxLoss, maxTrades } = state.settings;
  const st = state.stats;
  let why = null;
  if (target != null && st.net >= target) why = "Profit target reached (" + fmtSigned(st.net) + ")";
  else if (maxLoss != null && st.net <= -maxLoss) why = "Total loss limit reached (" + fmtSigned(st.net) + ")";
  else if (maxTrades != null && st.trades >= maxTrades) why = "Max trades reached (" + st.trades + ")";
  if (why && (state.session === "running" || state.session === "paused")) {
    state.session = "done";
    renderControls();
    toast(why + " — session stopped.", why.startsWith("Profit") ? "success" : "info");
  }
  return !!why;
}

function interruptSimulation(reason) {
  if (state.execution === "demo") {
    state.demoHalted = true;
    if (state.demo && ["running", "paused"].includes(state.demo.status)) void demoControl("stop");
    toast(reason + " Demo entries stopped; the existing Deriv contract is still monitored.", "error");
    return;
  }
  if (!state.pos && state.session !== "running" && state.session !== "paused") return;
  if (state.pos) {
    const pos = state.pos;
    state.pos = null;
    state.stats.unresolved += 1;
    // No invented win, loss, refund, or P/L for a contract with missing observations.
    appendHistory(pos, { outcome: "unresolved", win: false, pnl: null, detail: reason });
    renderStats();
    renderHistory();
  }
  state.session = "done";
  renderLastTrade();
  renderControls();
  toast(reason + " Session stopped; any unresolved result is shown in history.", "error");
}

function startSession() {
  unlockAudio();
  if (state.execution === "demo") return void startDemoSession();
  if (state.session === "running") return;
  if (state.pos && state.session !== "paused") {
    toast("The previous session's open contract must finish before starting a new session.", "info");
    return;
  }
  if (state.session === "paused" && checkSessionLimits()) return;
  if (!liveSimulationReady()) {
    toast("Wait for verified live Deriv ticks before starting research. The synthetic feed is display only.", "info");
    return;
  }
  if (state.session === "idle" || state.session === "done") {
    state.stats = freshStats();
    state.history = [];
    state.seq = 0;
    state.lastResult = null;
    renderStats();
    renderHistory();
    renderLastTrade();
  }
  state.session = "running";
  renderControls();
}

function pauseSession() {
  if (state.execution === "demo") return void demoControl("pause");
  if (state.session !== "running") return;
  state.session = "paused"; // an open contract still settles normally
  renderControls();
}

function stopSession() {
  if (state.execution === "demo") return void demoControl("stop");
  if (state.session === "idle") return;
  state.session = "done";
  renderControls();
  toast("Session stopped" + (state.pos ? " — the open contract will settle and be counted." : "."), "info");
}

/* ======================= comparison tool (backtest) ====================== */

function seededRandom(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function runBacktest(prices, pip, product, cfgBase, opts) {
  const digits = prices.map((p) => lastDigit(p, pip));
  const st = freshStats();
  const rand = seededRandom(42);
  let pos = null;
  for (let i = FREQ_WINDOW; i < prices.length; i++) {
    if (pos) {
      const res = stepContract(pos, prices[i], digits[i]);
      if (res) {
        pos = null;
        recordSettlement(st, res);
      } else markDrawdown(st, openPnl(pos));
      continue;
    }
    const cfg = { ...cfgBase };
    if (product === "differs") {
      if (opts.digitRule === "random") cfg.digit = Math.floor(rand() * 10);
      else if (opts.digitRule === "auto") cfg.digit = coldestDigit(digits.slice(i - FREQ_WINDOW, i)); // past only
      cfg.m = opts.mFor(cfg.digit);
    }
    if (opts.filter && !entryAllowed(product, prices.slice(Math.max(0, i - 30), i + 1), [digits[i]], cfg)) continue;
    pos = openContract(cfg, prices[i]);
    markDrawdown(st, openPnl(pos));
  }
  if (pos) st.unresolved += 1;
  return st;
}

async function runComparison() {
  const btn = $("lab-run-btn");
  if (!btn) return;
  if (!state.pub || !state.pub.isOpen()) return toast("Needs the live Deriv connection.", "error");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const s = state.settings;
    const r = await state.pub.request({ ticks_history: s.symbol, count: 1000, end: "latest", style: "ticks" }, 30000);
    const prices = ((r.history && r.history.prices) || []).map(Number);
    const pip = Number(r.pip_size) || state.lastPip;
    if (prices.length < 200) throw new Error("not enough history");
    const mFor = (d) => differsMultiplier(d).m;
    const stake = s.stake;
    const diff = { product: "differs", stake, digit: s.digit };
    const accu = { product: "accu", stake, tp: s.contractTp, growth: s.growth, ...accuParams() };
    const mult = { product: "mult", stake, tp: s.contractTp, mult: s.mult, dir: s.dir, commRate: multCommissionRate().rate };
    const rows = [
      ["Differs · fixed digit " + s.digit, runBacktest(prices, pip, "differs", diff, { mFor })],
      ["Differs · random digit", runBacktest(prices, pip, "differs", diff, { mFor, digitRule: "random" })],
      ["Differs · legacy coldest 100 (past only)", runBacktest(prices, pip, "differs", diff, { mFor, digitRule: "auto" })],
      ["Differs · fixed + entry filter", runBacktest(prices, pip, "differs", diff, { mFor, filter: true })],
      ["Accumulator " + Math.round(s.growth * 100) + "%", runBacktest(prices, pip, "accu", accu, {})],
      ["Accumulator + calm-entry filter", runBacktest(prices, pip, "accu", accu, { filter: true })],
      ["Multiplier ×" + s.mult + " " + s.dir, runBacktest(prices, pip, "mult", mult, {})],
      ["Multiplier + trend filter", runBacktest(prices, pip, "mult", mult, { filter: true })],
    ];
    const body = $("lab-body");
    body.textContent = "";
    for (const [name, st] of rows) {
      const tr = document.createElement("tr");
      const cells = [
        name, st.trades + (st.unresolved ? " · " + st.unresolved + " unresolved" : ""),
        st.trades ? ((st.wins / st.trades) * 100).toFixed(1) + "%" : "—", fmtSigned(st.net), money(st.maxDD),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i === 3) td.className = st.net >= 0 ? "pl-pos" : "pl-neg";
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    const be = (1 / differsMultiplier(s.digit).m) * 100;
    $("lab-note").textContent =
      (prices.length - FREQ_WINDOW) + " ticks of " + s.symbol + ". Estimated replay using current public quotes, not historical executable payouts. Differs: " + (differsMultiplier(s.digit).live ? "public quote" : "fallback estimate") + "; Accumulator: " + (accuParams().live ? "quoted barrier" : "fallback barrier") + "; Multiplier: " + (multCommissionRate().live ? "quoted fee" : "fallback fee") + ". Differs break-even: " + be.toFixed(1) + "% wins. Small differences are usually chance. P/L is settled only; unresolved end positions have unknown final results. Drawdown includes observed open P/L; zero-profit settlements are break-even.";
    $("lab-output").hidden = false;
  } catch (err) {
    toast("Comparison failed: " + errText(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run comparison";
  }
}

/* Independent virtual wallet and walk-forward studies. Public reads only. */
async function runVirtualResearch() {
  const button = $("research-run"), status = $("research-status"), engine = window.DerivResearch;
  if (!engine) return toast("Research module unavailable. Refresh the page.", "error");
  if (!liveSimulationReady() || !state.pub?.isOpen()) return toast("Research needs verified live public market data.", "error");
  const limit = (id) => {
    const raw = $(id).value.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Session limits must be positive or left blank.");
    return value;
  };
  button.disabled = true; $("research-output").hidden = true;
  try {
    const options = { balance: Number($("research-balance").value), stake: Number($("research-stake").value),
      target: limit("research-target"), maxLoss: limit("research-loss"), direction: state.settings.dir };
    if (![options.balance, options.stake].every(v => Number.isFinite(v) && v > 0 && engine.cents(v) === v)) throw new Error("Use positive amounts with at most two decimal places.");
    const { symbol, mult, growth } = state.settings;
    const pub = state.pub;
    status.textContent = "Reading public history. Your Deriv balance and session are separate.";
    const history = await pub.request({ ticks_history: symbol, count: 1000, end: "latest", style: "ticks" }, 30000);
    const data = { symbol, prices: (history.history?.prices || []).map(Number), times: history.history?.times || [], pip: Number(history.pip_size) };
    engine.validate(data);
    const specs = engine.quoteSpecs(symbol, data.prices.at(-1), { stake: options.stake, mult, growth });
    const quotes = {};
    let failed = 0;
    for (let i = 0; i < specs.length; i++) {
      if (state.settings.symbol !== symbol || state.demoFeed || !pub.isOpen()) throw new Error("Market or public connection changed. Run the study again.");
      status.textContent = "Reading current proposal " + (i + 1) + "/" + specs.length + " · public quotes only; historical payouts remain estimates.";
      try {
        const response = await pub.request(specs[i].request, 10000);
        const quote = engine.quoteRecord(specs[i], response, Math.floor(Date.now() / 1000));
        if (quote) quotes[quote.key] = quote;
        else failed++;
      } catch (error) {
        failed++;
        if (/ratelimit/i.test(String(error?.code))) { failed += specs.length - i - 1; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    const report = engine.compare(data, quotes, options);
    const body = $("research-body"); body.textContent = "";
    const percentage = n => n == null ? "—" : (n * 100).toFixed(1) + "%";
    const row = (target, values) => {
      const tr = document.createElement("tr");
      values.forEach(value => { const td = document.createElement("td"); td.textContent = String(value); tr.appendChild(td); });
      target.appendChild(tr);
    };
    for (const candidate of report.rows) {
      const r = candidate.holdout;
      const be = r.quotedBreakEven ? percentage(r.quotedBreakEven[0]) + (Math.abs(r.quotedBreakEven[1] - r.quotedBreakEven[0]) > .0001 ? "–" + percentage(r.quotedBreakEven[1]) : "") : r.empiricalBreakEven == null ? "Not established" : percentage(r.empiricalBreakEven) + " (observed mix)";
      row(body, [candidate.name, r.trades + " / " + percentage(r.winRate), fmtSigned(r.net),
        (r.averageWin == null ? "—" : money(r.averageWin)) + " / " + (r.averageLoss == null ? "—" : money(r.averageLoss)),
        be, money(r.maxDD), r.maxLossStreak, r.status + (r.unavailable ? " · " + r.unavailable + " unquoted signals" : "")]);
    }
    const staking = $("research-staking"); staking.textContent = "";
    for (const r of report.staking) row(staking, [r.staking + (r.staking === "martingale3" ? " · RISK EXAMPLE" : ""), r.trades,
      fmtSigned(r.net), money(r.maxDD), money(r.available), r.status]);
    $("research-selection").textContent = report.decision + ". " + report.selectionNote +
      (report.selected ? " Staking reference: " + report.stakingReference + "." : " No staking projection is made.") + " Selection never uses the held-out results. No strategy is promoted to the bot.";
    $("research-caveat").textContent = report.caveat + " A maximum-duration buffer prevents contracts crossing evaluation boundaries; short phases can be too short for long contracts. Binary open positions are valued at cost, not an invented resale quote; their final P/L is unknown. Multiplier stops use observed prices and can slip beyond intended limits. Progressive stakes scale snapshot quotes approximately and may change real pricing. Paroli increases exposure after wins; Martingale increases it after losses and stops after three levels or insufficient funds.";
    status.textContent = symbol + " · " + data.prices.length + " ticks · " + new Date(data.times[0] * 1000).toISOString() + " to " + new Date(data.times.at(-1) * 1000).toISOString() +
      ". First 40% training (200-tick warm-up), next 20% validation, final 40% held out. " + failed + " unavailable quotes/models; no substitute payouts. All results use the separate virtual wallet.";
    $("research-output").hidden = false;
  } catch (error) { status.textContent = "Research stopped: " + errText(error); }
  finally { button.disabled = false; }
}

/* ------------------------------ REST helpers ----------------------------- */

function errText(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.message || err.code || "unknown error";
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

async function demoApi(path, method = "GET", body) {
  const headers = {};
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (state.csrf) headers["X-Deriv-CSRF"] = state.csrf;
  }
  const response = await fetch("/api/deriv" + path, {
    method, headers, credentials: "same-origin", cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(typeof data?.detail === "string" ? data.detail : "Demo request failed. Reconnect and check the session status.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function handleOAuthReturn() {
  if (!location.hash || location.hash.length < 2) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return false;
  history.replaceState(null, "", location.pathname + location.search);
  if (error) {
    toast("Deriv login cancelled or rejected. Please try again.", "error");
    return true;
  }
  const pkce = ssGet(PKCE_KEY);
  ssSet(PKCE_KEY, null);
  if (!pkce || pkce.state !== params.get("state")) {
    toast("Login check failed — please sign in again from this browser tab.", "error");
    return true;
  }
  try {
    const data = await demoApi("/token", "POST", { code, code_verifier: pkce.verifier, redirect_uri: redirectUri() });
    applyDemoSnapshot(data, true);
    startAccountPolling();
    closeConnectDialog();
  } catch (err) {
    showConnectError(errText(err));
    openConnectDialog();
  }
  return true;
}

function loadCred() {
  // Remove credentials left by the old view-only build. Only PKCE state stays client-side.
  ssSet(CRED_KEY, null);
  const a = ssGet(ACTIVE_KEY);
  if (typeof a === "string") state.activeId = a;
}

async function connectAccounts(silent = false) {
  if (state.connecting) return false;
  state.connecting = true;
  try {
    const data = await demoApi("/session");
    applyDemoSnapshot(data);
    // Reload never silently resumes actual order submission.
    if (data.run?.status === "running") {
      state.demoHalted = true;
      applyDemoSnapshot(await demoApi("/demo/control", "POST", { action: "pause" }));
    }
    startAccountPolling();
    return true;
  } catch (err) {
    if (!silent) { showConnectError(errText(err)); openConnectDialog(); }
    return false;
  } finally {
    state.connecting = false;
    renderAccount();
  }
}

function startAccountPolling() {
  clearInterval(state.accountPoll);
  let busy = false;
  state.accountPoll = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      applyDemoSnapshot(await demoApi("/session"));
    } catch (err) {
      state.demoHalted = true;
      state.account = null; // Do not present a stale balance as a verified live connection.
      if (err.status === 401) {
        clearInterval(state.accountPoll);
        state.account = null;
        state.cred = null;
        toast("Demo session expired or the backend restarted. Reconnect to recover pending contracts.", "error");
      }
      renderAccount(); renderControls();
    } finally { busy = false; }
  }, 2000);
}

function applyDemoSnapshot(data, reset = false) {
  if (reset) { state.sessionView = data.session_view; state.snapshotRevision = 0; }
  if (state.sessionView && data.session_view !== state.sessionView) return;
  if (data.revision < state.snapshotRevision) return;
  state.sessionView = data.session_view;
  state.snapshotRevision = data.revision;
  state.csrf = data.csrf;
  state.cred = { kind: "server" };
  state.accounts = data.accounts || [];
  state.linkedAccounts = data.linked_accounts || [];
  state.linkedAccountsTime = data.accounts_updated_at || null;
  state.linkedAccountsError = data.accounts_error || null;
  state.account = data.connected ? data.account : null;
  state.owner = data.owner || null;
  state.activeId = data.account?.id || null;
  ssSet(ACTIVE_KEY, state.activeId);
  state.demo = data.run || null;
  if (state.demo?.pending || ["running", "paused"].includes(state.demo?.status)) {
    state.execution = "demo";
    $("execution-mode").value = "demo";
  }
  if (state.execution === "demo" && state.demo) {
    const run = state.demo;
    if (state.demoRunId !== run.id) {
      state.stats = freshStats();
      state.demoRunId = run.id;
    }
    state.session = state.demoHalted && run.status === "running" ? "done" : run.status;
    const rows = run.history || [];
    let total = 0;
    const history = [...rows].reverse().map((row, index) => {
      total = Math.round((total + row.profit) * 100) / 100;
      return { n: index + 1, time: new Date(row.closed_at * 1000), symbol: row.symbol,
        label: row.label, detail: "Deriv Demo contract " + row.contract_id + " · actual settlement",
        stake: row.buy_price, pnl: row.profit, outcome: row.status, win: row.profit > 0, cum: total };
    });
    state.history = history.reverse().slice(0, HISTORY_LIMIT);
    const settled = freshStats();
    for (const row of [...rows].reverse()) recordSettlement(settled, { pnl: row.profit });
    state.stats.peak = Math.max(state.stats.peak, settled.peak);
    state.stats.maxDD = Math.max(state.stats.maxDD, settled.maxDD);
    Object.assign(state.stats, {
      trades: rows.length, wins: rows.filter((r) => r.profit > 0).length,
      losses: rows.filter((r) => r.profit < 0).length, breakEven: rows.filter((r) => r.profit === 0).length,
      net: run.net, sumWin: rows.reduce((n, r) => n + Math.max(0, r.profit), 0),
      sumLoss: rows.reduce((n, r) => n + Math.min(0, r.profit), 0),
    });
    markDrawdown(state.stats, run.pending?.profit || 0);
    renderStats(); renderHistory(); renderLastTrade();
  }
  renderAccount(); renderExecutionMode(); renderControls();
  renderTicket(); renderDigitExplain();
}

async function connectWithToken() {
  const input = $("token-input");
  const token = input.value.trim();
  input.value = "";
  if (!token) return showConnectError("Enter your token privately in this connection form.");
  setConnectBusy(true);
  try {
    applyDemoSnapshot(await demoApi("/session", "POST", { token }), true);
    startAccountPolling(); closeConnectDialog();
  } catch (err) { showConnectError(errText(err)); }
  finally { setConnectBusy(false); }
}

async function switchAccount(id) {
  if (!id || id === state.activeId) return;
  try { applyDemoSnapshot(await demoApi("/account", "POST", { account_id: id })); }
  catch (err) { toast(errText(err), "error"); renderAccount(); }
}

async function clearCred() {
  const result = await demoApi("/disconnect", "POST", {});
  clearInterval(state.accountPoll);
  state.demoHalted = true;
  state.session = "done";
  state.cred = null; state.csrf = null; state.account = null; state.accounts = [];
  state.activeId = null; state.demo = null;
  state.linkedAccounts = []; state.linkedAccountsTime = null; state.linkedAccountsError = null;
  state.sessionView = "disconnected"; // Reject an already in-flight pre-disconnect poll.
  ssSet(CRED_KEY, null); ssSet(ACTIVE_KEY, null);
  renderAccount(); renderControls();
  toast(result.pending_contract ? "Disconnected. The existing Demo contract is still monitored; no new orders will start." : "Disconnected from Deriv Demo.", "info");
}

function changeExecutionMode() {
  const el = $("execution-mode");
  if (["running", "paused"].includes(state.session) || state.pos || state.demo?.pending) {
    el.value = state.execution;
    return toast("Stop the current session and let its contract finish before changing mode.", "info");
  }
  state.execution = el.value;
  state.session = "idle"; state.stats = freshStats(); state.history = []; state.lastResult = null;
  if (state.execution === "demo" && state.demo) applyDemoSnapshot({ connected: !!state.account, account: state.account,
    accounts: state.accounts, linked_accounts: state.linkedAccounts, accounts_updated_at: state.linkedAccountsTime,
    accounts_error: state.linkedAccountsError, owner: state.owner, csrf: state.csrf, run: state.demo, session_view: state.sessionView, revision: state.snapshotRevision });
  renderExecutionMode(); renderStrategy(); renderStats(); renderHistory(); renderLastTrade(); renderControls();
}

function renderExecutionMode() {
  const demo = state.execution === "demo";
  $("mode-badge").textContent = demo ? "Deriv Demo · actual contracts" : "Research · virtual money";
  $("account-mode-note").textContent = demo ? "Demo orders enabled · Live accounts blocked" : "Simulation sends no orders · Live accounts blocked";
  $("trade-type-label").textContent = demo ? "Trade type · Deriv Demo" : "Trade type · virtual";
  $("session-label").textContent = demo ? "Session · actual Demo results" : "Session · virtual";
  $("history-label").textContent = demo ? "Deriv Demo contract history" : "Virtual trade history (simulated)";
  $("mode-disclaimer").textContent = demo ? "Actual Deriv Demo contracts use Demo funds. Live-account execution is blocked." : "Virtual-money simulation on live Deriv data. No orders are placed in simulation mode.";
  $("execution-note").textContent = demo ? state.demo?.error || (state.cfg.demo_execution_enabled ? "Start Demo trading places actual contracts in your USD Demo account. Settings stay fixed until the session ends." : "Demo execution is disabled on the backend until deployment is approved and configured.") : "Simulation uses separate virtual results and never changes the Deriv balance.";
}

async function startDemoSession() {
  if (state.demoBusy) return;
  if (!state.account?.isVirtual || state.account.currency !== "USD") return toast("Connect an authorised USD Demo account first.", "error");
  if (!liveSimulationReady()) return toast("Wait for live Deriv market data.", "error");
  if (state.settings.autoDigit || state.settings.entryFilter) return toast("Experimental comparison filters remain simulation-only. Use manual settings for Demo execution.", "info");
  state.demoBusy = true; renderControls();
  try {
    const s = state.settings;
    const data = state.demo?.status === "paused" ? await demoApi("/demo/control", "POST", { action: "resume" }) : await demoApi("/demo/start", "POST", {
      symbol: s.symbol, product: s.product, stake: s.stake, digit: s.digit, growth: s.growth,
      mult: s.mult, direction: s.dir, target: s.target, max_loss: s.maxLoss, max_trades: s.maxTrades,
    });
    state.demoHalted = false;
    applyDemoSnapshot(data);
  } catch (err) { state.demoHalted = true; toast(errText(err), "error"); }
  finally { state.demoBusy = false; renderControls(); }
}

async function demoSignal() {
  if (state.demoBusy || state.demoHalted || state.demo?.pending) return;
  state.demoBusy = true;
  try { applyDemoSnapshot(await demoApi("/demo/signal", "POST", {})); }
  catch (err) {
    state.demoHalted = true;
    toast(errText(err), "error");
    await demoControl("stop");
  } finally { state.demoBusy = false; renderControls(); }
}

async function demoControl(action) {
  if (action === "stop") state.demoHalted = true;
  try { applyDemoSnapshot(await demoApi("/demo/control", "POST", { action })); }
  catch (err) { state.demoHalted = true; toast(errText(err), "error"); }
  renderControls();
}


/* -------------------------------- formatting ----------------------------- */

const fmtCache = {};
function money(value, currency) {
  const cur = currency || "USD";
  try {
    if (!fmtCache[cur]) fmtCache[cur] = new Intl.NumberFormat("en-US", { style: "currency", currency: cur });
    return fmtCache[cur].format(value);
  } catch {
    return Number(value).toFixed(2) + " " + cur;
  }
}
const fmtSigned = (v) => (v >= 0 ? "+" : "−") + money(Math.abs(v));
const fmtClock = (d) => d.toLocaleTimeString([], { hour12: false });
const symbolName = (code) => (SYMBOLS.find((s) => s[0] === code) || [code, code])[1];

const FLAGS = {
  USD: '<svg viewBox="0 0 30 20" width="30" height="20"><rect width="30" height="20" fill="#B22234"/><g fill="#fff"><rect y="1.54" width="30" height="1.54"/><rect y="4.62" width="30" height="1.54"/><rect y="7.69" width="30" height="1.54"/><rect y="10.77" width="30" height="1.54"/><rect y="13.85" width="30" height="1.54"/><rect y="16.92" width="30" height="1.54"/></g><rect width="12" height="10.77" fill="#3C3B6E"/></svg>',
  EUR: '<svg viewBox="0 0 30 20" width="30" height="20"><rect width="30" height="20" fill="#003399"/><circle cx="15" cy="10" r="5" fill="none" stroke="#FFCC00" stroke-width="1.4" stroke-dasharray="1.2 1.4"/></svg>',
  GBP: '<svg viewBox="0 0 30 20" width="30" height="20"><rect width="30" height="20" fill="#012169"/><path d="M0 0 30 20M30 0 0 20" stroke="#fff" stroke-width="4"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#C8102E" stroke-width="3.4"/></svg>',
  AUD: '<svg viewBox="0 0 30 20" width="30" height="20"><rect width="30" height="20" fill="#012169"/><path d="M7.5 0v10M0 5h15" stroke="#fff" stroke-width="3"/><path d="M7.5 0v10M0 5h15" stroke="#C8102E" stroke-width="1.6"/><g fill="#fff"><circle cx="7.5" cy="15" r="1.6"/><circle cx="22.5" cy="5" r="1"/><circle cx="25.5" cy="9" r="1"/><circle cx="22.5" cy="16" r="1"/></g></svg>',
};

/* -------------------------------- rendering ------------------------------ */

const DESCRIPTIONS = {
  differs: "Wins if the next tick's last digit is NOT your digit. Win ≈ +7–10% of stake; loss = full stake.",
  accu: "Stake grows each tick while price stays in Deriv's range. Closes at +10% of stake; knock-out loses the stake.",
  mult: "P/L = stake × multiplier × price move − commission. Closes at +10% of stake; loss capped at stake.",
};

function renderAll() {
  setStatus(state.status);
  renderAccount();
  renderStrategy();
  renderQuote(null);
  renderTrail();
  renderFreq();
  renderDigitPayouts();
  renderStats();
  renderHistory();
  renderLastTrade();
  renderControls();
  renderExecutionMode();
}

function renderAccount() {
  const acc = state.account;
  const linked = $("linked-accounts-list");
  linked.textContent = "";
  $("linked-accounts").hidden = !state.linkedAccounts.length;
  for (const account of state.linkedAccounts) {
    const line = document.createElement("p");
    line.textContent = account.id + " · " + (account.type === "real" ? "Real · view only" : "Demo") + " · " + money(account.balance, account.currency) + " " + account.currency;
    linked.appendChild(line);
  }
  $("linked-accounts-time").textContent = (state.linkedAccountsError ? state.linkedAccountsError + " " : "") +
    (state.linkedAccountsTime ? "Account-list snapshot: " + new Date(state.linkedAccountsTime * 1000).toLocaleTimeString() + ". Refreshes about every 30 seconds." : "");
  $("connect-button-nav").textContent = acc ? acc.id : state.cred ? "Connecting…" : "Connect";
  $("account-empty").hidden = !!acc;
  $("account-live").hidden = !acc;
  const sel = $("account-select");
  sel.hidden = !(acc && state.accounts.length > 1);
  if (!acc) return;
  const cur = String(acc.currency).toUpperCase();
  $("account-owner").textContent = state.owner || acc.id;
  $("currency-flag").innerHTML = FLAGS[cur] || "";
  $("currency-flag").hidden = !FLAGS[cur];
  $("balance-value").textContent = money(acc.balance, acc.currency);
  $("balance-currency").textContent = acc.currency;
  $("account-loginid").textContent = acc.id + " · authorised Deriv Demo balance";
  const badge = $("account-type");
  badge.textContent = acc.isVirtual ? "Demo" : "Real";
  badge.className = "badge " + (acc.isVirtual ? "badge-demo" : "badge-real");
  if (!sel.hidden) {
    sel.textContent = "";
    for (const a of state.accounts) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.id + " · " + (a.isVirtual ? "Demo" : "Real") + " · " + money(a.balance, a.currency);
      sel.appendChild(opt);
    }
    sel.value = acc.id;
  }
}

function renderStrategy() {
  const s = state.settings;
  document.querySelectorAll("[data-product]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.product === s.product)));
  document.querySelectorAll("[data-dir]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dir === s.dir)));
  document.querySelectorAll("[data-growth]").forEach((b) => b.classList.toggle("chip-on", Number(b.dataset.growth) === s.growth));
  const chips = $("mult-chips");
  chips.textContent = "";
  for (const m of multsFor(s.symbol)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (m === s.mult ? " chip-on" : "");
    b.dataset.mult = String(m);
    b.dataset.testid = "mult-chip-" + m;
    b.textContent = "×" + m;
    chips.appendChild(b);
  }
  document.querySelectorAll(".digit").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.digit) === s.digit)));
  $("strategy-description").textContent = DESCRIPTIONS[s.product];
  $("accu-options").hidden = s.product !== "accu";
  $("mult-options").hidden = s.product !== "mult";
  $("digit-section").hidden = s.product !== "differs";
  const setVal = (id, v) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = v == null ? "" : v;
  };
  setVal("stake-input", s.stake.toFixed(2));
  setVal("target-input", s.target);
  setVal("maxloss-input", s.maxLoss);
  $("stake-input").min = STAKE_MIN[s.product];
  renderTicket();
  renderDigitExplain();
}

/** Exact figures for the NEXT virtual contract, before it opens. */
function renderTicket() {
  const s = state.settings;
  const stake = s.stake;
  $("tk-payout-label").textContent = state.execution === "demo" ? "Return reference" : "Payout if win";
  $("tk-profit-label").textContent = state.execution === "demo" ? "Profit reference" : "Profit if win";
  if (state.execution === "demo") {
    const last = state.demo?.pending || state.demo?.history?.[0];
    const compatible = last && last.product === s.product && last.stake === stake && last.symbol === s.symbol;
    const settledWin = compatible && last.status === "win" && last.sell_price > stake && last.profit > 0;
    const payout = settledWin ? last.sell_price : last?.quoted_payout;
    const profit = settledWin ? last.profit : last?.quoted_profit;
    const quoted = compatible && Number.isFinite(payout) && payout > stake && profit > 0;
    $("tk-stake").textContent = money(stake);
    $("tk-loss").textContent = "−" + money(stake);
    $("tk-payout").textContent = s.product === "differs" ? quoted ? money(payout) : "Quoted at entry" : "Variable";
    $("tk-profit").textContent = s.product === "differs" ? quoted ? "+" + money(profit) : "Quoted at entry" : "10% target · not guaranteed";
    $("tk-note").textContent = quoted ? (settledWin ? "Last actual winning settlement" : "Last authenticated entry quote") + " · digit " + last.digit + " · break-even " + (100 * stake / payout).toFixed(1) + "% wins · one full loss ≈ " + (stake / profit).toFixed(1) + " such wins. Future quotes and returns may differ." :
      "Demo amounts come from the authenticated entry quote and actual Deriv settlement. Public quote estimates are not used here. Maximum contractual loss remains the stake.";
    return;
  }
  let payout, profit, note;
  if (s.product === "differs") {
    const q = differsMultiplier(s.digit);
    payout = Math.round(stake * q.m * 100) / 100;
    profit = Math.round((payout - stake) * 100) / 100;
    note = (q.live ? "Live quote " : "Est. ") + q.m.toFixed(3) + "× · break-even " + (100 / q.m).toFixed(1) + "% wins · 1 loss ≈ " + (stake / Math.max(profit, 0.01)).toFixed(0) + " wins";
  } else if (s.product === "accu") {
    const a = accuParams();
    profit = s.contractTp;
    payout = stake + profit;
    const ticks = Math.ceil(Math.log(1 + profit / stake) / Math.log(1 + s.growth));
    note = "Needs ≈" + ticks + " ticks inside ±" + (a.barrier * 100).toFixed(3) + "%" + (a.live ? " (live barrier)" : " (est.)");
  } else {
    const c = multCommissionRate();
    const comm = Math.round(stake * s.mult * c.rate * 100) / 100;
    profit = s.contractTp;
    payout = stake + profit;
    const need = ((profit + comm) / (stake * s.mult)) * 100;
    const out = ((stake - comm) / (stake * s.mult)) * 100;
    note = "Commission " + money(comm) + (c.live ? " (live)" : " (est.)") + " · target " + need.toFixed(3) + "% move · stop-out " + out.toFixed(3) + "% against";
  }
  $("tk-stake").textContent = money(stake);
  $("tk-payout").textContent = money(payout);
  $("tk-profit").textContent = "+" + money(profit);
  $("tk-loss").textContent = "−" + money(stake);
  $("tk-note").textContent = note;
}

function renderDigitExplain() {
  const s = state.settings;
  if (s.product !== "differs") return;
  const d = s.digit;
  const total = state.freqQueue.length;
  $("digit-explain").textContent = total
    ? "Digit " + d + ": " + state.freq[d] + " of last " + total + " ticks (" + ((state.freq[d] / total) * 100).toFixed(0) + "%, fair 10%). History only, not a prediction."
    : "Digit " + d + " selected. Waiting for ticks…";
}

function renderControls() {
  const ss = state.session;
  const demo = state.execution === "demo";
  const pending = demo ? !!state.demo?.pending : !!state.pos;
  const active = ["running", "paused"].includes(ss) || pending;
  $("start-btn").disabled = ss === "running" || !liveSimulationReady() || (ss !== "paused" && pending) ||
    (demo && (!state.cfg.demo_execution_enabled || state.demoBusy || !state.account?.isVirtual || state.account.currency !== "USD"));
  $("start-btn").textContent = demo ? ss === "paused" ? "Resume Demo" : "Start Demo trading" : ss === "paused" ? "Resume" : ss === "done" ? "New session" : "Start";
  $("pause-btn").disabled = ss !== "running";
  $("stop-btn").disabled = demo ? !["running", "paused"].includes(state.demo?.status) : ss === "idle" || ss === "done";
  $("running-indicator").hidden = ss !== "running" && ss !== "paused";
  $("running-text").textContent = ss === "paused" ? "Paused" : demo ? "Running · Deriv Demo contracts" : "Running · virtual";
  $("symbol-select").disabled = demo ? active : !!state.pos;
  $("execution-mode").disabled = active;
  $("account-select").disabled = demo && active;
  for (const id of ["stake-input", "target-input", "maxloss-input"]) $(id).disabled = demo && active;
  document.querySelectorAll("[data-product], [data-dir], [data-growth], [data-mult], .digit").forEach((el) => { el.disabled = demo && active; });
}

function renderQuote(entry) {
  if (!entry) {
    $("quote-main").textContent = "—";
    $("quote-digit").textContent = "";
    $("quote-meta").textContent = state.demoFeed ? "Synthetic demo feed — Deriv unreachable" : "Connecting to Deriv…";
    return;
  }
  $("quote-main").textContent = entry.quoteStr.slice(0, -1);
  const dEl = $("quote-digit");
  dEl.textContent = entry.digit;
  $("quote-meta").textContent = symbolName(state.settings.symbol) + " · " + fmtClock(new Date(entry.epoch * 1000)) + (state.demoFeed ? " · synthetic demo feed" : " · live");
  dEl.classList.remove("flash");
  void dEl.offsetWidth;
  dEl.classList.add("flash");
}

function renderTrail() {
  const wrap = $("tick-trail");
  wrap.textContent = "";
  for (let i = 0; i < TICK_TRAIL; i++) {
    const cell = document.createElement("span");
    const t = state.trail[i];
    cell.className = "digit-cell" + (!t ? " placeholder" : (i === 0 ? " newest" : "") + (t.digit === state.settings.digit ? " match" : ""));
    cell.textContent = t ? t.digit : "·";
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
    col.title = d + ": " + state.freq[d] + " of " + total + " ticks";
    col.innerHTML = '<div class="freq-track"><div class="freq-bar" style="height:' + (state.freq[d] / max) * 100 + '%"></div></div><span class="freq-label">' + d + "</span>";
    wrap.appendChild(col);
  }
}

function renderDigitPayouts() {
  for (let d = 0; d <= 9; d++) {
    const el = document.querySelector('[data-digit-pay="' + d + '"]');
    if (!el) continue;
    const q = differsMultiplier(d);
    el.textContent = (q.live ? "" : "≈") + q.m.toFixed(3) + "×";
    el.classList.toggle("live", q.live);
  }
}

function renderLastTrade() {
  const el = $("last-trade");
  if (state.execution === "demo") {
    const p = state.demo?.pending;
    el.className = "last-trade" + (p ? " open" : "");
    if (p) el.textContent = (p.contract_id ? "OPEN · Deriv Demo contract " + p.contract_id : "SUBMITTING / UNRESOLVED · Deriv Demo") +
      " · " + p.label + " · stake " + money(p.stake) + (p.profit == null ? " · awaiting Deriv result" : " · current P/L " + fmtSigned(p.profit));
    else {
      const last = state.history[0];
      el.textContent = last ? last.detail + " · " + last.outcome.toUpperCase() + " " + fmtSigned(last.pnl) : state.demo?.error || "No Demo contract yet. Start Demo trading sends actual orders.";
    }
    return;
  }
  if (state.pos) {
    const p = state.pos;
    const pnl = openPnl(p);
    el.className = "last-trade open";
    el.textContent = "OPEN · " + contractLabel(p) + " · stake " + money(p.stake) +
      (p.product === "differs" ? " · settles next tick" : " · tick " + p.ticks + " · value " + money(p.stake + pnl) + " (" + fmtSigned(pnl) + ")");
    return;
  }
  const lr = state.lastResult;
  if (!lr) {
    el.className = "last-trade";
    el.textContent = "No contract yet.";
    return;
  }
  const outcome = lr.res.outcome;
  el.className = "last-trade " + (outcome === "win" ? "win" : outcome === "loss" ? "loss" : "");
  el.textContent = (outcome === "unresolved" ? "UNRESOLVED · P/L unknown" : outcome === "break-even" ? "BREAK-EVEN " + money(0) : (lr.res.win ? "WIN " : "LOSS ") + fmtSigned(lr.res.pnl)) +
    " · " + contractLabel(lr.pos) + " · stake " + money(lr.pos.stake) + " · " + lr.res.detail;
}

function renderStats() {
  const st = state.stats;
  $("stat-wins").textContent = String(st.wins);
  $("stat-losses").textContent = String(st.losses);
  $("stat-win-rate").textContent = (st.trades ? ((st.wins / st.trades) * 100).toFixed(1) + "%" : "—") + (st.unresolved ? "*" : "");
  $("stat-win-rate").title = "Wins / settled trades, including break-even trades. Unresolved trades are excluded; * means incomplete results.";
  const pnlEl = $("stat-pnl");
  pnlEl.textContent = st.net === 0 ? money(0) : fmtSigned(st.net);
  pnlEl.classList.toggle("win", st.net > 0);
  pnlEl.classList.toggle("loss", st.net < 0);
  $("stat-trades").textContent = st.trades + (st.trades === 1 ? " settled trade" : " settled trades") +
    (st.breakEven ? " · " + st.breakEven + " break-even" : "") + (st.unresolved ? " · " + st.unresolved + " unresolved (P/L incomplete)" : "");
  $("stat-dd").textContent = "max equity drawdown " + money(st.maxDD);
}

function renderHistory() {
  const body = $("trade-history-body");
  body.textContent = "";
  $("trade-history-empty").hidden = state.history.length > 0;
  $("history-count").textContent = state.history.length ? "· " + state.history.length : "";
  for (const t of state.history) {
    const tr = document.createElement("tr");
    [String(t.n), fmtClock(t.time), t.label, money(t.stake)].forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    });
    const pl = document.createElement("td");
    pl.textContent = t.outcome === "unresolved" ? "Unknown" : fmtSigned(t.pnl);
    pl.className = t.pnl > 0 ? "pl-pos" : t.pnl < 0 ? "pl-neg" : "";
    const res = document.createElement("td");
    const label = t.outcome === "unresolved" ? "Unresolved" : t.outcome === "break-even" ? "Break-even" : t.win ? "Win" : "Loss";
    res.innerHTML = '<span class="badge ' + (t.outcome === "win" ? "badge-win" : t.outcome === "loss" ? "badge-loss" : "badge-sim") + '">' + label + "</span>";
    tr.title = t.symbol + " · " + t.detail + " · settled session P/L " + fmtSigned(t.cum);
    tr.append(pl, res);
    body.appendChild(tr);
  }
}

let flashTimer = null;
function showResultFlash(win, stake, pnl) {
  const el = $("result-flash");
  const ratio = (stake + pnl) / stake;
  const label = pnl === 0 ? "BREAK-EVEN " : win ? "WIN " : "LOSS ";
  el.className = "result-flash " + (pnl === 0 ? "" : win ? "win" : "loss") + (win && ratio >= 3 ? " big" : "");
  el.innerHTML = '<span class="rf-mult">×' + Math.max(0, ratio).toFixed(2) + '</span><span class="rf-txt">' + label + fmtSigned(pnl) + " (virtual)</span>";
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 1200);
  $("result-announcer").textContent = label + fmtSigned(pnl);
}

/* ------------------------------ sound alerts ----------------------------- */

let audioCtx = null;
function unlockAudio() {
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

/* ----------------------------- dialogs + toasts -------------------------- */

function openConnectDialog() {
  $("oauth-block").hidden = !state.cfg.oauth_ready;
  $("oauth-redirect-url").textContent = redirectUri();
  const d = $("connect-dialog");
  if (!d.open) d.showModal();
}
function closeConnectDialog() {
  const d = $("connect-dialog");
  if (d.open) d.close();
  showConnectError("");
}
function showConnectError(m) {
  $("connect-error").hidden = !m;
  $("connect-error").textContent = m || "";
}
function setConnectBusy(busy) {
  $("token-connect-button").disabled = busy;
  $("token-connect-button").textContent = busy ? "Connecting…" : "Connect";
  renderAccount();
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

/* --------------------------------- events -------------------------------- */

function changeSetting(patch, requote) {
  if (state.execution === "demo" && (["running", "paused"].includes(state.session) || state.demo?.pending)) {
    return toast("Demo session settings stay fixed. Stop and let its contract settle before changing them.", "info");
  }
  if (patch.symbol && patch.symbol !== state.settings.symbol && state.pos) {
    $("symbol-select").value = state.settings.symbol;
    toast("Wait for the open virtual contract to finish before changing markets.", "info");
    return;
  }
  Object.assign(state.settings, patch);
  clampStakeToProduct();
  saveSettings();
  renderStrategy();
  renderTrail();
  renderFreq();
  checkSessionLimits();
  if (requote) refreshQuotes();
}

/** Null-safe binding: a missing element is logged, never crashes init. */
function on(target, event, handler) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) {
    console.warn("[Deriv Edge Lab] missing element #" + target + " — handler skipped");
    return;
  }
  el.addEventListener(event, handler);
}

function bindEvents() {
  const sel = $("symbol-select");
  if (sel) {
    for (const [code, name] of SYMBOLS) sel.add(new Option(name, code));
    sel.value = state.settings.symbol;
    on(sel, "change", () => {
      changeSetting({ symbol: sel.value }, true);
      subscribeTicks(sel.value);
    });
  }
  document.querySelectorAll("[data-product]").forEach((b) => on(b, "click", () => changeSetting({ product: b.dataset.product }, true)));
  document.querySelectorAll("[data-dir]").forEach((b) => on(b, "click", () => changeSetting({ dir: b.dataset.dir })));
  document.querySelectorAll("[data-growth]").forEach((b) => on(b, "click", () => changeSetting({ growth: Number(b.dataset.growth) }, true)));
  on("mult-chips", "click", (e) => {
    const b = e.target.closest("[data-mult]");
    if (b) changeSetting({ mult: Number(b.dataset.mult) }, true);
  });
  document.querySelectorAll(".digit").forEach((b) => on(b, "click", () => changeSetting({ digit: Number(b.dataset.digit) })));
  on("stake-input", "change", (e) => changeSetting({ stake: Number(e.target.value) || STAKE_MIN[state.settings.product] }, true));
  on("target-input", "change", (e) => changeSetting({ target: num(e.target.value, 0.01) }));
  on("maxloss-input", "change", (e) => changeSetting({ maxLoss: num(e.target.value, 0.01) }));
  on("start-btn", "click", startSession);
  on("pause-btn", "click", pauseSession);
  on("stop-btn", "click", stopSession);
  on("lab-run-btn", "click", runComparison);
  on("research-run", "click", runVirtualResearch);
  on("execution-mode", "change", changeExecutionMode);

  on("connect-button", "click", openConnectDialog);
  on("connect-button-nav", "click", () => {
    if (state.account) $("account-card").scrollIntoView({ behavior: "smooth", block: "start" });
    else openConnectDialog();
  });
  on("oauth-connect-button", "click", startOAuth);
  on("token-form", "submit", (e) => {
    e.preventDefault();
    connectWithToken();
  });
  on("connect-cancel-button", "click", closeConnectDialog);
  on("connect-dialog", "click", (e) => e.target === $("connect-dialog") && closeConnectDialog());
  on("disconnect-button", "click", async () => {
    try { await clearCred(); } catch (err) { toast(errText(err), "error"); }
  });
  on("account-select", "change", (e) => switchAccount(e.target.value));

  document.addEventListener("keydown", (e) => {
    if ($("connect-dialog").open || state.settings.product !== "differs") return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (/^[0-9]$/.test(e.key)) changeSetting({ digit: Number(e.key) });
  });


}

/* ---------------------------------- init --------------------------------- */

async function init() {
  loadSettings();
  loadCred();
  bindEvents();
  renderAll();
  await loadConfig();
  connectPublic();
  const handled = await handleOAuthReturn();
  if (!handled) connectAccounts(true);
}

init();
