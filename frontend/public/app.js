/* ==========================================================================
 * Deriv Edge Lab — app.js  (vanilla JS, no build step)
 *
 * TWO SEPARATE AREAS
 *   Research simulation — real Deriv ticks (public WebSocket) + VIRTUAL money.
 *                         Never places Deriv contracts.
 *   Connected account   — OAuth (PKCE) or API token → account list, real
 *                         balance via OTP WebSocket. VIEW-ONLY: this file
 *                         contains no buy/sell calls (execution disabled).
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
 *                 the profit target (or after 600 ticks at market).
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
  oauth_authorize_url: "https://auth.deriv.com/oauth2/auth",
};

const DIFFERS_FALLBACK = 1.09; // only until live quotes arrive (labelled "≈")
const ACCU_FALLBACK = { 0.01: 0.0009, 0.02: 0.0007, 0.03: 0.000537, 0.04: 0.00045, 0.05: 0.0004 };
const MULT_COMMISSION_FALLBACK = 0.00036; // fraction of stake × multiplier
const MULT_MAX_TICKS = 600;
const HISTORY_LIMIT = 500;
const TICK_TRAIL = 10;
const FREQ_WINDOW = 100;
const STAKE_MIN = { differs: 0.35, accu: 1, mult: 1 };
const STAKE_MAX = { differs: 5000, accu: 200, mult: 500 };

const CRED_KEY = "del.cred";
const ACTIVE_KEY = "del.activeAccount";
const PKCE_KEY = "del.pkce";
const SETTINGS_KEY = "del.settings.v4";
const AI_SESSION_KEY = "del.aiSession";

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
  account: null,
  activeId: null,
  owner: null,
  connecting: false,
  tradeRetryDelay: 1000,
  settings: {
    symbol: "R_100", product: "differs", digit: 5, autoDigit: false, stake: 1, entryFilter: false,
    growth: 0.03, mult: 100, dir: "up", contractTp: 1, target: null, maxLoss: null, maxTrades: null, sound: true,
  },
  trail: [],
  freq: new Array(10).fill(0),
  freqQueue: [],
  prices: [], // recent prices (for entry filters)
  lastPip: 2,
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
  return { trades: 0, wins: 0, losses: 0, net: 0, sumWin: 0, sumLoss: 0, peak: 0, maxDD: 0 };
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
    if ([40, 100, 200, 300, 400].includes(s.mult)) t.mult = s.mult;
    if (s.dir === "up" || s.dir === "down") t.dir = s.dir;
    t.autoDigit = !!s.autoDigit;
    t.entryFilter = !!s.entryFilter;
    t.sound = s.sound !== false;
    t.stake = num(s.stake, 0.35) || 1;
    t.contractTp = num(s.contractTp, 0.1) || 1;
    t.target = num(s.target, 0.01);
    t.maxLoss = num(s.maxLoss, 0.01);
    t.maxTrades = num(s.maxTrades, 1) ? Math.floor(s.maxTrades) : null;
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

async function loadConfig() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/api/deriv/config", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const d = await res.json();
    if (d.app_id && d.app_id !== "1089") state.cfg.app_id = String(d.app_id);
    if (d.public_ws_url) state.cfg.public_ws_url = d.public_ws_url;
    if (d.api_base) state.cfg.api_base = d.api_base;
    if (d.oauth_authorize_url) state.cfg.oauth_authorize_url = d.oauth_authorize_url;
    state.cfg.oauth_ready = !!d.oauth_ready;
  } catch {
    /* standalone (e.g. CodePen): API-token connect still works */
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
  renderTrail();
  renderFreq();
  renderQuote(null);
}

async function subscribeTicks(symbol) {
  voidOpenPosition("market changed");
  if (state.demoFeed) return startDemoTimer(symbol, false);
  if (!state.pub || !state.pub.isOpen()) return;
  await state.pub.request({ forget_all: "ticks" }, 10000).catch(() => {});
  resetFeedState();
  setStatus("live");
  try {
    await state.pub.request({ ticks: symbol, subscribe: 1 });
  } catch (err) {
    toast("Could not subscribe to " + symbol + ": " + errText(err), "error");
  }
}

/* Labelled synthetic feed — ONLY when Deriv's public gateway is unreachable. */
function startDemoTimer(symbol, announce) {
  stopDemoTimer();
  state.demoFeed = true;
  resetFeedState();
  setStatus("demo");
  if (announce) toast("Deriv is unreachable from this network — showing a labelled demo feed until it's back.", "info");
  let price = 572.26;
  state.demoTimer = setInterval(() => {
    price *= 1 + (Math.random() - 0.5) * 0.0016;
    onTick({ quote: price, pip_size: 2, epoch: Math.floor(Date.now() / 1000), symbol });
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

function onTick(tick) {
  const pip = Number.isFinite(Number(tick.pip_size)) ? Number(tick.pip_size) : 2;
  state.lastPip = pip;
  const price = Number(tick.quote);
  const quoteStr = price.toFixed(pip);
  const digit = Number(quoteStr.charAt(quoteStr.length - 1));
  state.trail.unshift({ quoteStr, digit, epoch: tick.epoch });
  if (state.trail.length > TICK_TRAIL) state.trail.pop();
  state.freq[digit] += 1;
  state.freqQueue.push(digit);
  if (state.freqQueue.length > FREQ_WINDOW) state.freq[state.freqQueue.shift()] -= 1;
  state.prices.push(price);
  if (state.prices.length > 200) state.prices.shift();
  renderQuote({ quoteStr, digit, epoch: tick.epoch });
  renderTrail();
  renderFreq();
  renderDigitExplain();
  if (tick.symbol && tick.symbol !== state.settings.symbol) return;
  simulateTick(price, digit);
}

function simulateTick(price, digit) {
  if (state.pos) {
    const res = stepContract(state.pos, price, digit);
    if (res) settle(res);
    else renderLastTrade();
    return; // never open a new contract on the tick that settled one
  }
  if (state.session !== "running") return;
  const cfg = currentCfg();
  if (state.settings.entryFilter && !entryAllowed(cfg.product, state.prices, state.freqQueue, cfg)) return;
  if (cfg.product === "differs" && state.settings.autoDigit && cfg.digit !== state.settings.digit) {
    state.settings.digit = cfg.digit;
    renderStrategy();
  }
  state.pos = openContract(cfg, price);
  state.pos.openedAt = new Date();
  renderLastTrade();
}

function settle(res) {
  const pos = state.pos;
  state.pos = null;
  const st = state.stats;
  st.trades += 1;
  if (res.win) {
    st.wins += 1;
    st.sumWin += res.pnl;
  } else {
    st.losses += 1;
    st.sumLoss += res.pnl;
  }
  st.net = Math.round((st.net + res.pnl) * 100) / 100;
  st.peak = Math.max(st.peak, st.net);
  st.maxDD = Math.max(st.maxDD, Math.round((st.peak - st.net) * 100) / 100);
  state.history.unshift({
    n: ++state.seq, time: new Date(), symbol: state.settings.symbol, product: pos.product,
    label: contractLabel(pos), detail: res.detail, stake: pos.stake, pnl: res.pnl, win: res.win, cum: st.net, digit: pos.digit,
  });
  if (state.history.length > HISTORY_LIMIT) state.history.pop();
  state.lastResult = { pos, res };
  renderStats();
  renderHistory();
  renderLastTrade();
  showResultFlash(res.win, pos.stake, res.pnl);
  playResultSound(res.win);
  checkSessionLimits();
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
  else if (maxLoss != null && st.net <= -maxLoss) why = "Max session loss reached (" + fmtSigned(st.net) + ")";
  else if (maxTrades != null && st.trades >= maxTrades) why = "Max trades reached (" + st.trades + ")";
  if (why && state.session === "running") {
    state.session = "done";
    renderControls();
    toast(why + " — session stopped.", why.startsWith("Profit") ? "success" : "info");
  }
}

function voidOpenPosition(reason) {
  if (!state.pos) return;
  state.pos = null;
  renderLastTrade();
  toast("Open virtual contract cancelled (" + reason + ") — not counted.", "info");
}

function startSession() {
  unlockAudio();
  if (state.session === "running") return;
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
  if (state.session !== "running") return;
  state.session = "paused"; // an open contract still settles normally
  renderControls();
}

function stopSession() {
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
        st.trades += 1;
        if (res.win) {
          st.wins += 1;
          st.sumWin += res.pnl;
        } else {
          st.losses += 1;
          st.sumLoss += res.pnl;
        }
        st.net = Math.round((st.net + res.pnl) * 100) / 100;
        st.peak = Math.max(st.peak, st.net);
        st.maxDD = Math.max(st.maxDD, st.peak - st.net);
      }
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
  }
  return st;
}

async function runComparison() {
  const btn = $("lab-run-btn");
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
      ["Differs · auto (coldest, walk-forward)", runBacktest(prices, pip, "differs", diff, { mFor, digitRule: "auto" })],
      ["Differs · fixed + entry filter", runBacktest(prices, pip, "differs", diff, { mFor, filter: true })],
      ["Accumulator " + Math.round(s.growth * 100) + "% · TP $" + s.contractTp, runBacktest(prices, pip, "accu", accu, {})],
      ["Accumulator + calm-entry filter", runBacktest(prices, pip, "accu", accu, { filter: true })],
      ["Multiplier ×" + s.mult + " " + s.dir + " · TP $" + s.contractTp, runBacktest(prices, pip, "mult", mult, {})],
      ["Multiplier + trend filter", runBacktest(prices, pip, "mult", mult, { filter: true })],
    ];
    const body = $("lab-body");
    body.textContent = "";
    for (const [name, st] of rows) {
      const tr = document.createElement("tr");
      const cells = [
        name, String(st.trades), st.trades ? ((st.wins / st.trades) * 100).toFixed(1) + "%" : "—",
        st.wins ? money(st.sumWin / st.wins) : "—", st.losses ? money(st.sumLoss / st.losses) : "—",
        fmtSigned(st.net), money(st.maxDD),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i === 5) td.className = st.net >= 0 ? "pl-pos" : "pl-neg";
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    const be = (1 / differsMultiplier(s.digit).m) * 100;
    $("lab-note").textContent =
      "Tested on " + (prices.length - FREQ_WINDOW) + " ticks of " + s.symbol + " (first 100 used only as history). " +
      "Differs break-even win rate at " + differsMultiplier(s.digit).m.toFixed(3) + "× is " + be.toFixed(1) + "%. " +
      "If auto or filtered rows beat the random row, that can still be chance on 1,000 ticks — re-run later before trusting it.";
    $("lab-output").hidden = false;
  } catch (err) {
    toast("Comparison failed: " + errText(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run comparison";
  }
}

/* ------------------------------ REST helpers ----------------------------- */

function errText(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.message || err.code || "unknown error";
}

function authHeaders() {
  const c = state.cred;
  if (!c) return {};
  const h = { Authorization: "Bearer " + c.token };
  if (c.kind === "pat") {
    h["Deriv-App-ID"] = state.cfg.app_id;
    h["X-Deriv-Token-Kind"] = "pat";
  }
  return h;
}

async function derivRest(method, path) {
  if (!state.cred) throw new Error("Not connected");
  const headers = authHeaders();
  delete headers["X-Deriv-Token-Kind"];
  if (method !== "GET") headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(state.cfg.api_base + path, { method, headers, body: method === "GET" ? undefined : "{}" });
  } catch {
    throw new Error("Could not reach Deriv's API from this network.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && (data.message || (data.errors && data.errors[0] && data.errors[0].message))) || "Deriv returned HTTP " + res.status);
    e.status = res.status;
    throw e;
  }
  return data;
}

/* ------------------------------ sign-in flow ----------------------------- */

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
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pkce.verifier, redirect_uri: redirectUri() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) throw new Error((data && data.detail) || "token exchange failed");
    setCred({ token: data.access_token, kind: "oauth", expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
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

async function connectAccounts() {
  if (!state.cred || state.connecting) return false;
  state.connecting = true;
  setConnectBusy(true);
  try {
    const data = await derivRest("GET", "/trading/v1/options/accounts");
    const list = ((data && data.data) || [])
      .filter((a) => a && a.account_id && a.status !== "inactive")
      .map((a) => ({ id: String(a.account_id), currency: a.currency || "USD", balance: Number(a.balance) || 0, isVirtual: a.account_type === "demo" }));
    if (!list.length) throw new Error("No active Options accounts found on this login.");
    state.accounts = list;
    derivRest("GET", "/account/v1/nickname")
      .then((r) => {
        if (r && r.data && r.data.nickname) {
          state.owner = String(r.data.nickname);
          renderAccount();
        }
      })
      .catch(() => {});
    await openAccountSocket(list.find((a) => a.id === state.activeId) || list.find((a) => a.isVirtual) || list[0]);
    closeConnectDialog();
    checkAiAccess();
    return true;
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      clearCred();
      showConnectError(err.status === 403 ? "That token lacks the Trade scope." : "Deriv rejected the token (expired or invalid). Please connect again.");
    } else showConnectError(errText(err));
    openConnectDialog();
    renderAccount();
    return false;
  } finally {
    state.connecting = false;
    setConnectBusy(false);
  }
}

/** View-only account socket: balance stream. No orders are ever sent. */
async function openAccountSocket(acc) {
  if (state.trade) state.trade.close();
  state.account = null;
  state.activeId = acc.id;
  ssSet(ACTIVE_KEY, acc.id);
  renderAccount();
  const otp = await derivRest("POST", "/trading/v1/options/accounts/" + encodeURIComponent(acc.id) + "/otp");
  const url = otp && otp.data && otp.data.url;
  if (!url) throw new Error("Deriv did not return a connection URL.");
  await new Promise((resolve, reject) => {
    let opened = false;
    const sock = makeSocket({
      onOpen: () => {
        opened = true;
        state.tradeRetryDelay = 1000;
        state.account = { ...acc };
        renderAccount();
        sock.request({ balance: 1, subscribe: 1 }).catch(() => {});
        toast("Connected to " + acc.id + " (" + (acc.isVirtual ? "Demo" : "Real") + ")", "success");
        resolve();
      },
      onMessage: (msg) => {
        if (!msg.error && msg.msg_type === "balance" && msg.balance) onBalance(msg.balance);
      },
      onClose: () => {
        if (!opened) return reject(new Error("Account connection was refused by Deriv."));
        state.account = null;
        renderAccount();
        if (!state.cred || state.activeId !== acc.id) return;
        setTimeout(() => {
          if (state.cred && state.activeId === acc.id && !(state.trade && state.trade.isBusy())) openAccountSocket(acc).catch(() => {});
        }, state.tradeRetryDelay);
        state.tradeRetryDelay = Math.min(state.tradeRetryDelay * 2, 30000);
      },
    });
    state.trade = sock;
    sock.open(url);
  });
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
  if (!token) return showConnectError("Paste your API token first.");
  showConnectError("");
  setCred({ token, kind: "pat", expiresAt: null });
  if (await connectAccounts()) $("token-input").value = "";
}

function switchAccount(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (acc && id !== state.activeId) openAccountSocket(acc).catch((err) => toast("Could not switch: " + errText(err), "error"));
}

function clearCred() {
  state.cred = null;
  ssSet(CRED_KEY, null);
  ssSet(ACTIVE_KEY, null);
  if (state.trade) state.trade.close();
  Object.assign(state, { trade: null, account: null, accounts: [], activeId: null, owner: null });
  $("ai-card").hidden = true;
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
  differs: "Digit Differs, 1 tick: you pick a digit to AVOID. Wins if the next tick's last digit is any other digit (~90% of ticks). A win pays Deriv's quoted payout (about 1.07–1.10× stake, so +7–10%); a loss costs the full stake. Break-even needs ≈92–93% wins.",
  accu: "Accumulator: your stake grows by the chosen % every tick while the price stays inside Deriv's tight range. One tick outside the range loses the stake. The contract closes when it reaches your profit target. Higher growth = faster gains but a tighter range.",
  mult: "Multiplier: profit or loss = stake × multiplier × price move %, minus Deriv's commission. Loss is capped at your stake (automatic stop-out). The contract closes at your profit target. Higher multiplier = bigger swings both ways.",
};

const FILTER_LABELS = {
  differs: "Entry filter: skip the tick right after your digit appeared",
  accu: "Entry filter: only enter after 5 calm ticks",
  mult: "Entry filter: only enter when the last 20 ticks moved in your direction",
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
}

function renderAccount() {
  const acc = state.account;
  $("connect-button-nav").textContent = acc ? acc.id : state.cred ? "Connecting…" : "Connect";
  $("account-empty").hidden = !!acc;
  $("account-live").hidden = !acc;
  const sel = $("account-select");
  sel.hidden = !(acc && state.accounts.length > 1);
  if (!acc) return;
  const cur = String(acc.currency).toUpperCase();
  $("account-owner").textContent = state.owner || (acc.isVirtual ? "Demo trader" : "Account holder");
  $("currency-flag").innerHTML = FLAGS[cur] || "";
  $("currency-flag").hidden = !FLAGS[cur];
  $("balance-value").textContent = money(acc.balance, acc.currency);
  $("balance-currency").textContent = acc.currency;
  $("account-loginid").textContent = acc.id + " · real Deriv balance";
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
  document.querySelectorAll("[data-mult]").forEach((b) => b.classList.toggle("chip-on", Number(b.dataset.mult) === s.mult));
  document.querySelectorAll("[data-stake]").forEach((b) => b.classList.toggle("chip-on", Number(b.dataset.stake) === s.stake));
  document.querySelectorAll(".digit").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.digit) === s.digit)));
  $("strategy-description").textContent = DESCRIPTIONS[s.product];
  $("entry-filter-label").textContent = FILTER_LABELS[s.product];
  $("accu-options").hidden = s.product !== "accu";
  $("mult-options").hidden = s.product !== "mult";
  $("contract-tp-block").hidden = s.product === "differs";
  $("digit-section").hidden = s.product !== "differs";
  $("auto-digit-toggle").checked = s.autoDigit;
  $("entry-filter-toggle").checked = s.entryFilter;
  $("sound-toggle").checked = s.sound;
  const setVal = (id, v) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = v == null ? "" : v;
  };
  setVal("stake-input", s.stake.toFixed(2));
  setVal("contract-tp-input", s.contractTp);
  setVal("target-input", s.target);
  setVal("maxloss-input", s.maxLoss);
  setVal("maxtrades-input", s.maxTrades);
  $("stake-input").min = STAKE_MIN[s.product];
  renderTicket();
  renderDigitExplain();
}

/** Exact figures for the NEXT virtual contract, before it opens. */
function renderTicket() {
  const s = state.settings;
  const stake = s.stake;
  let payout, profit, note;
  if (s.product === "differs") {
    const q = differsMultiplier(s.digit);
    payout = Math.round(stake * q.m * 100) / 100;
    profit = Math.round((payout - stake) * 100) / 100;
    note = (q.live ? "Live Deriv quote " : "Estimate (live quote loading) ") + q.m.toFixed(4) + "× · break-even win rate " + (100 / q.m).toFixed(1) + "%. One loss ≈ " + (stake / Math.max(profit, 0.01)).toFixed(1) + " wins.";
  } else if (s.product === "accu") {
    const a = accuParams();
    profit = s.contractTp;
    payout = stake + profit;
    const ticks = Math.ceil(Math.log(1 + profit / stake) / Math.log(1 + s.growth));
    note = "Needs ≈" + ticks + " ticks in a row inside ±" + (a.barrier * 100).toFixed(4) + "% (" + (a.live ? "live Deriv barrier" : "estimated barrier") + "), max " + a.maxTicks + " ticks.";
  } else {
    const c = multCommissionRate();
    const comm = Math.round(stake * s.mult * c.rate * 100) / 100;
    profit = s.contractTp;
    payout = stake + profit;
    const need = ((profit + comm) / (stake * s.mult)) * 100;
    const out = ((stake - comm) / (stake * s.mult)) * 100;
    note = "Commission " + money(comm) + (c.live ? " (live)" : " (est.)") + ". Target needs a " + need.toFixed(3) + "% move " + s.dir + "; stop-out at a " + out.toFixed(3) + "% move against you.";
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
  let lastSeen = -1;
  for (let i = state.freqQueue.length - 1; i >= 0; i--) if (state.freqQueue[i] === d) {
    lastSeen = state.freqQueue.length - 1 - i;
    break;
  }
  const why = s.autoDigit ? "Auto-selected: least frequent digit in the last 100 ticks. " : "";
  $("digit-explain").textContent =
    why + "Selected " + d + ": the virtual contract wins if the next tick's last digit is NOT " + d + ". " +
    (total ? "In the last " + total + " ticks, " + d + " appeared " + state.freq[d] + " times (" + ((state.freq[d] / total) * 100).toFixed(0) + "%; fair share 10%)" +
      (lastSeen >= 0 ? ", last seen " + lastSeen + " ticks ago." : ".") : "Waiting for ticks…") +
    " This is history, not a prediction — each tick is independent.";
}

function renderControls() {
  const ss = state.session;
  $("start-btn").disabled = ss === "running";
  $("start-btn").textContent = ss === "paused" ? "Resume" : ss === "done" ? "New session" : "Start";
  $("pause-btn").disabled = ss !== "running";
  $("stop-btn").disabled = ss === "idle" || ss === "done";
  $("running-indicator").hidden = ss !== "running" && ss !== "paused";
  $("running-text").textContent = ss === "paused" ? "Paused — session kept" : "Running — one virtual contract at a time";
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
    const q = differsMultiplier(d);
    el.textContent = (q.live ? "" : "≈") + q.m.toFixed(3) + "×";
    el.classList.toggle("live", q.live);
  }
}

function renderLastTrade() {
  const el = $("last-trade");
  if (state.pos) {
    const p = state.pos;
    const pnl = Math.round((p.value - p.stake) * 100) / 100;
    el.className = "last-trade open";
    el.textContent = "OPEN · " + contractLabel(p) + " · stake " + money(p.stake) +
      (p.product === "differs" ? " · settles next tick" : " · tick " + p.ticks + " · value " + money(p.value) + " (" + fmtSigned(pnl) + ")");
    return;
  }
  const lr = state.lastResult;
  if (!lr) {
    el.className = "last-trade";
    el.textContent = "No contract yet.";
    return;
  }
  el.className = "last-trade " + (lr.res.win ? "win" : "loss");
  el.textContent = (lr.res.win ? "WIN " : "LOSS ") + fmtSigned(lr.res.pnl) + " · " + contractLabel(lr.pos) + " · stake " + money(lr.pos.stake) + " · " + lr.res.detail;
}

function renderStats() {
  const st = state.stats;
  $("stat-wins").textContent = String(st.wins);
  $("stat-losses").textContent = String(st.losses);
  $("stat-win-rate").textContent = st.trades ? ((st.wins / st.trades) * 100).toFixed(1) + "%" : "—";
  const pnlEl = $("stat-pnl");
  pnlEl.textContent = st.net === 0 ? money(0) : fmtSigned(st.net);
  pnlEl.classList.toggle("win", st.net > 0);
  pnlEl.classList.toggle("loss", st.net < 0);
  $("stat-trades").textContent = st.trades + (st.trades === 1 ? " trade" : " trades");
  $("stat-avg").textContent = "avg win " + (st.wins ? money(st.sumWin / st.wins) : "—") + " / avg loss " + (st.losses ? money(st.sumLoss / st.losses) : "—");
  $("stat-dd").textContent = "max drawdown " + money(st.maxDD);
}

function renderHistory() {
  const body = $("trade-history-body");
  body.textContent = "";
  $("trade-history-empty").hidden = state.history.length > 0;
  $("history-count").textContent = state.history.length ? "· " + state.history.length + " contracts (scroll for older)" : "";
  for (const t of state.history) {
    const tr = document.createElement("tr");
    [String(t.n), fmtClock(t.time), t.symbol, t.label, t.detail, money(t.stake)].forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    });
    const pl = document.createElement("td");
    pl.textContent = fmtSigned(t.pnl);
    pl.className = t.pnl >= 0 ? "pl-pos" : "pl-neg";
    const cum = document.createElement("td");
    cum.textContent = fmtSigned(t.cum);
    cum.className = "muted";
    const res = document.createElement("td");
    res.innerHTML = '<span class="badge ' + (t.win ? "badge-win" : "badge-loss") + '">' + (t.win ? "Win" : "Loss") + "</span>";
    tr.append(pl, cum, res);
    body.appendChild(tr);
  }
}

let flashTimer = null;
function showResultFlash(win, stake, pnl) {
  const el = $("result-flash");
  const ratio = (stake + pnl) / stake;
  el.className = "result-flash " + (win ? "win" : "loss") + (win && ratio >= 3 ? " big" : "");
  el.innerHTML = '<span class="rf-mult">×' + Math.max(0, ratio).toFixed(2) + '</span><span class="rf-txt">' + (win ? "WIN " : "LOSS ") + fmtSigned(pnl) + " (virtual)</span>";
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 1200);
  $("result-announcer").textContent = (win ? "Win " : "Loss ") + fmtSigned(pnl);
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

/* ---------------------------- AI coach (owner) --------------------------- */

let aiBusy = false;

function aiSessionId() {
  let id = "";
  try {
    id = localStorage.getItem(AI_SESSION_KEY) || "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(AI_SESSION_KEY, id);
    }
  } catch {
    id = id || "s" + Date.now().toString(36);
  }
  return id;
}

/** Shows the AI card only when the server confirms (via Deriv) that this is the owner AND AI is configured. */
async function checkAiAccess() {
  $("ai-card").hidden = true;
  if (!state.cred) return;
  try {
    const res = await fetch("/api/ai/access", { headers: authHeaders() });
    if (!res.ok) return;
    const d = await res.json();
    if (d.owner && d.ai_available) {
      $("ai-card").hidden = false;
      loadAiHistory();
    }
  } catch {
    /* no backend — AI stays hidden */
  }
}

function aiContext() {
  const s = state.settings;
  const st = state.stats;
  return {
    mode: "sim", account_type: state.account ? (state.account.isVirtual ? "demo" : "real") : null,
    currency: "USD", balance: null, symbol: s.symbol, digit: s.digit, stake: s.stake,
    payout_multiplier: s.product === "differs" ? differsMultiplier(s.digit).m : null,
    product: s.product, growth_rate: s.growth, multiplier: s.mult, direction: s.dir, contract_take_profit: s.contractTp,
    take_profit: s.target, stop_loss: s.maxLoss, max_trades: s.maxTrades,
    trades: st.trades, wins: st.wins, losses: st.losses, net: st.net, max_drawdown: st.maxDD,
    recent_trades: state.history.slice(0, 60).map((t) => ({
      live: false, symbol: t.symbol, product: t.product, detail: t.detail, digit: t.digit == null ? null : t.digit,
      stake: t.stake, pnl: t.pnl, win: t.win,
    })),
  };
}

async function aiStream(path, body, onDelta) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => null);
    throw new Error((d && d.detail) || "AI unavailable (HTTP " + res.status + ")");
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!line.startsWith("data:")) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.error) throw new Error(ev.error);
      if (ev.delta) onDelta((full += ev.delta));
    }
  }
  return full;
}

function setAiBusy(b) {
  aiBusy = b;
  $("ai-coach-btn").disabled = b;
  $("ai-send-btn").disabled = b;
  $("ai-coach-btn").textContent = b ? "Thinking…" : "Analyze my session";
}

async function runCoach() {
  if (aiBusy) return;
  const out = $("ai-coach-output");
  out.hidden = false;
  out.textContent = "";
  out.classList.add("typing");
  setAiBusy(true);
  try {
    await aiStream("/api/ai/coach", { context: aiContext() }, (t) => (out.textContent = t));
  } catch (err) {
    out.textContent = errText(err);
  } finally {
    out.classList.remove("typing");
    setAiBusy(false);
  }
}

function addAiMessage(role, text) {
  $("ai-empty").hidden = true;
  const el = document.createElement("div");
  el.className = "ai-msg " + role;
  el.textContent = text;
  $("ai-messages").appendChild(el);
  $("ai-messages").scrollTop = $("ai-messages").scrollHeight;
  return el;
}

async function sendAiMessage() {
  const input = $("ai-input");
  const text = input.value.trim();
  if (!text || aiBusy) return;
  input.value = "";
  addAiMessage("user", text);
  const bubble = addAiMessage("assistant", "");
  bubble.classList.add("typing");
  setAiBusy(true);
  try {
    await aiStream("/api/ai/chat", { session_id: aiSessionId(), message: text, context: aiContext() }, (t) => {
      bubble.textContent = t;
      $("ai-messages").scrollTop = $("ai-messages").scrollHeight;
    });
  } catch (err) {
    bubble.textContent = errText(err);
    bubble.classList.add("error");
  } finally {
    bubble.classList.remove("typing");
    setAiBusy(false);
  }
}

async function loadAiHistory() {
  try {
    const res = await fetch("/api/ai/chat/" + encodeURIComponent(aiSessionId()), { headers: authHeaders() });
    if (!res.ok) return;
    $("ai-messages").querySelectorAll(".ai-msg").forEach((e) => e.remove());
    for (const m of (await res.json()).messages || []) addAiMessage(m.role, m.text);
  } catch {
    /* ignore */
  }
}

async function clearAiChat() {
  await fetch("/api/ai/chat/" + encodeURIComponent(aiSessionId()), { method: "DELETE", headers: authHeaders() }).catch(() => {});
  $("ai-messages").querySelectorAll(".ai-msg").forEach((e) => e.remove());
  $("ai-empty").hidden = false;
}

/* --------------------------------- events -------------------------------- */

function changeSetting(patch, requote) {
  Object.assign(state.settings, patch);
  clampStakeToProduct();
  saveSettings();
  renderStrategy();
  renderTrail();
  renderFreq();
  if (requote) refreshQuotes();
}

function bindEvents() {
  const sel = $("symbol-select");
  for (const [code, name] of SYMBOLS) sel.add(new Option(name, code));
  sel.value = state.settings.symbol;
  sel.addEventListener("change", () => {
    changeSetting({ symbol: sel.value }, true);
    subscribeTicks(sel.value);
  });
  document.querySelectorAll("[data-product]").forEach((b) => b.addEventListener("click", () => changeSetting({ product: b.dataset.product }, true)));
  document.querySelectorAll("[data-dir]").forEach((b) => b.addEventListener("click", () => changeSetting({ dir: b.dataset.dir })));
  document.querySelectorAll("[data-growth]").forEach((b) => b.addEventListener("click", () => changeSetting({ growth: Number(b.dataset.growth) }, true)));
  document.querySelectorAll("[data-mult]").forEach((b) => b.addEventListener("click", () => changeSetting({ mult: Number(b.dataset.mult) }, true)));
  document.querySelectorAll("[data-stake]").forEach((b) => b.addEventListener("click", () => changeSetting({ stake: Number(b.dataset.stake) }, true)));
  document.querySelectorAll(".digit").forEach((b) => b.addEventListener("click", () => changeSetting({ digit: Number(b.dataset.digit), autoDigit: false })));
  $("stake-input").addEventListener("change", (e) => changeSetting({ stake: Number(e.target.value) || STAKE_MIN[state.settings.product] }, true));
  $("contract-tp-input").addEventListener("change", (e) => changeSetting({ contractTp: num(e.target.value, 0.1) || 1 }));
  $("target-input").addEventListener("change", (e) => changeSetting({ target: num(e.target.value, 0.01) }));
  $("maxloss-input").addEventListener("change", (e) => changeSetting({ maxLoss: num(e.target.value, 0.01) }));
  $("maxtrades-input").addEventListener("change", (e) => changeSetting({ maxTrades: num(e.target.value, 1) ? Math.floor(e.target.value) : null }));
  $("auto-digit-toggle").addEventListener("change", (e) => changeSetting({ autoDigit: e.target.checked }));
  $("entry-filter-toggle").addEventListener("change", (e) => changeSetting({ entryFilter: e.target.checked }));
  $("sound-toggle").addEventListener("change", (e) => {
    changeSetting({ sound: e.target.checked });
    if (e.target.checked) {
      unlockAudio();
      playResultSound(true);
    }
  });
  $("start-btn").addEventListener("click", startSession);
  $("pause-btn").addEventListener("click", pauseSession);
  $("stop-btn").addEventListener("click", stopSession);
  $("lab-run-btn").addEventListener("click", runComparison);

  $("connect-button").addEventListener("click", openConnectDialog);
  $("connect-button-nav").addEventListener("click", openConnectDialog);
  $("oauth-connect-button").addEventListener("click", startOAuth);
  $("token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectWithToken();
  });
  $("connect-cancel-button").addEventListener("click", closeConnectDialog);
  $("connect-dialog").addEventListener("click", (e) => e.target === $("connect-dialog") && closeConnectDialog());
  $("disconnect-button").addEventListener("click", () => {
    clearCred();
    renderAccount();
    toast("Disconnected — tokens cleared from this browser.", "info");
  });
  $("account-select").addEventListener("change", (e) => switchAccount(e.target.value));

  $("ai-coach-btn").addEventListener("click", runCoach);
  $("ai-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendAiMessage();
  });
  $("ai-clear-btn").addEventListener("click", clearAiChat);

  document.addEventListener("keydown", (e) => {
    if ($("connect-dialog").open || state.settings.product !== "differs") return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (/^[0-9]$/.test(e.key)) changeSetting({ digit: Number(e.key), autoDigit: false });
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
  if (!handled && state.cred) connectAccounts();
}

init();
