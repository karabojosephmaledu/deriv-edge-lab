/* Run with: node --test tests/simulation.test.cjs
 * Loads the actual browser script in a VM. No packages, network, database, tokens,
 * or Deriv orders are used. DOM, sockets and timers are controlled test doubles.
 */
const { test: nodeTest } = require("node:test");
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { execFileSync } = require("node:child_process");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const source = readFileSync(process.env.SIMULATION_APP_SOURCE || resolve(root, "frontend/public/app.js"), "utf8");
const html = readFileSync(resolve(root, "frontend/index.html"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(script = source) {
  const elements = new Map();
  function element() {
    return {
      children: [], dataset: {}, className: "", hidden: false, disabled: false, value: "", title: "", innerHTML: "",
      set textContent(value) { this.text = String(value); this.children = []; },
      get textContent() { return this.text || ""; },
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      remove() {}, setAttribute() {}, addEventListener() {}, add(child) { this.children.push(child); },
    };
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element());
  const storage = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  const intervals = new Map();
  const sockets = [];
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) || null,
      createElement: element, querySelectorAll: () => [], querySelector: element,
      activeElement: null, addEventListener() {},
    },
    console, WebSocket: Socket, localStorage: storage(), sessionStorage: storage(),
    setTimeout: () => ++timerId, clearTimeout() {},
    setInterval: (fn) => { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    window: {}, fetch: () => { throw new Error("Unexpected network request in offline test"); },
  });
  assert.match(script, /\ninit\(\);\s*$/);
  vm.runInContext(script.replace(/\ninit\(\);\s*$/, "\n"), context, { filename: "app.js" });
  const api = vm.runInContext(`({ state, freshStats, startSession, pauseSession, stopSession,
    onTick, simulateTick, subscribeTicks, connectPublic, startDemoTimer, stopDemoTimer,
    changeSetting, renderControls, renderStats, renderHistory, renderLastTrade,
    openContract, stepContract, runBacktest, currentCfg, lastDigit, coldestDigit, entryAllowed,
    differsMultiplier, accuParams, multCommissionRate, fetchContractInfo, subscribeDigitPayouts, applyDigitProposal,
    clampStakeToProduct, checkSessionLimits, ...(typeof reserveVirtualStake === "function" ? { reserveVirtualStake, settleVirtualStake, virtualBalance, captureVirtualState, validateVirtualSnapshot } : {}) })`, context);
  api.state.status = "live";
  api.state.lastTick = { symbol: "R_100", epoch: 1000 };
  api.state.pub = { isOpen: () => true, request: async () => ({}) };
  api.state.settings.stake = 100;
  api.clampStakeToProduct();
  let epoch = 1000;
  return {
    ...api, elements, intervals, sockets, context,
    tick(price = 100.01, patch = {}) {
      epoch += api.state.settings.symbol.startsWith("1HZ") ? 1 : 2;
      api.onTick({ symbol: api.state.settings.symbol, quote: price, pip_size: 2, epoch, ...patch });
    },
  };
}

test("1: an open old contract blocks a new session and settles only in its original ledger", () => {
  const a = harness();
  a.startSession(); a.tick(); a.stopSession();
  const old = a.state.pos;
  a.startSession();
  assert.equal(a.state.pos, old);
  assert.equal(a.state.session, "done");
  assert.equal(a.elements.get("start-btn").disabled, true);
  a.tick(100.05);
  assert.equal(a.state.stats.net, -100);
  assert.equal(a.state.stats.trades, 1);
  a.startSession();
  assert.equal(a.state.stats.trades, 0);
  assert.equal(a.state.history.length, 0);
  a.tick(); a.tick(100.02);
  assert.equal(a.state.stats.net, 9);
  assert.equal(a.state.history.length, 1);
  assert.equal(a.state.history[0].n, 1);
});

test("1: Pause/Resume preserves the same position, settings snapshot and ledger", () => {
  const a = harness();
  a.startSession(); a.tick(); a.pauseSession();
  const pos = a.state.pos;
  a.startSession();
  assert.equal(a.state.session, "running");
  assert.equal(a.state.pos, pos);
  a.tick(100.02);
  assert.equal(a.state.stats.trades, 1);
});

test("2: an Accumulator profit target reached while paused stops the old session", () => {
  const a = harness();
  Object.assign(a.state.settings, { product: "accu", target: 10 });
  a.startSession(); a.tick(100); a.pauseSession();
  for (let i = 0; i < 4; i++) a.tick(100);
  assert.equal(a.state.stats.net, 12.55);
  assert.equal(a.state.session, "done");
  assert.equal(a.elements.get("start-btn").textContent, "New session");
  a.tick(100);
  assert.equal(a.state.pos, null);
  assert.equal(a.state.stats.trades, 1);
});

test("2: a loss limit reached while paused stops the session", () => {
  const a = harness();
  a.state.settings.maxLoss = 100;
  a.startSession(); a.tick(); a.pauseSession(); a.tick(100.05);
  assert.equal(a.state.stats.net, -100);
  assert.equal(a.state.session, "done");
  a.tick();
  assert.equal(a.state.pos, null);
});

for (const [key, net, limit] of [["target", 12, 10], ["maxLoss", -12, 10]]) {
  test(`2: lowering ${key} while paused immediately latches Stop`, () => {
    const a = harness();
    a.startSession(); a.pauseSession(); a.state.stats.net = net;
    a.changeSetting({ [key]: limit });
    assert.equal(a.state.session, "done");
  });
  test(`2: Resume rechecks an already-reached ${key}`, () => {
    const a = harness();
    a.state.session = "paused";
    a.state.stats.net = net;
    a.state.settings[key] = limit;
    a.startSession();
    assert.equal(a.state.session, "done");
    assert.equal(a.state.stats.net, net);
  });
}

test("2: no entry can breach the full-stake loss budget, including after earlier losses", () => {
  const a = harness();
  a.state.settings.maxLoss = 100;
  a.startSession();
  a.state.stats.net = -1;
  a.tick();
  assert.equal(a.state.pos, null);
  assert.equal(a.state.session, "done");
  assert.equal(a.state.stats.net, -1);
});

test("2: tick entry rechecks the profit and maximum-trades limits", () => {
  for (const field of ["target", "maxTrades"]) {
    const a = harness();
    a.startSession();
    if (field === "target") { a.state.settings.target = 9; a.state.stats.net = 9; }
    else { a.state.settings.maxTrades = 1; a.state.stats.trades = 1; }
    a.tick();
    assert.equal(a.state.pos, null);
    assert.equal(a.state.session, "done");
  }
});

test("3: changing market is blocked until the open contract settles", async () => {
  const a = harness();
  a.startSession(); a.tick();
  const pos = a.state.pos;
  a.elements.get("symbol-select").value = "R_25";
  a.changeSetting({ symbol: "R_25" }, true);
  await a.subscribeTicks("R_25");
  assert.equal(a.state.settings.symbol, "R_100");
  assert.equal(a.elements.get("symbol-select").value, "R_100");
  assert.equal(a.elements.get("symbol-select").disabled, true);
  assert.equal(a.state.pos, pos);
  a.tick(100.02);
  assert.equal(a.state.history[0].symbol, "R_100");
  assert.equal(a.elements.get("symbol-select").disabled, false);
});

test("3: same-market subscription cannot discard a pending trade", async () => {
  const a = harness();
  a.startSession(); a.tick();
  const pos = a.state.pos;
  await a.subscribeTicks("R_100");
  assert.equal(a.state.pos, pos);
  assert.equal(a.state.history.length, 0);
});

test("3: socket interruption records an explicit unknown outcome once and stops", () => {
  const a = harness();
  a.startSession(); a.tick();
  a.state.pub = null;
  a.connectPublic();
  a.sockets[0].close();
  a.sockets[0].close();
  assert.equal(a.state.session, "done");
  assert.equal(a.state.pos, null);
  assert.equal(a.state.stats.unresolved, 1);
  assert.equal(a.state.stats.trades, 0);
  assert.equal(a.state.stats.net, 0);
  assert.equal(a.state.history.length, 1);
  assert.equal(a.state.history[0].outcome, "unresolved");
  assert.equal(a.state.history[0].pnl, null);
  assert.match(a.elements.get("last-trade").textContent, /UNRESOLVED/);
  assert.match(a.elements.get("stat-trades").textContent, /P\/L incomplete/);
  assert.equal(a.state.lastTick, null);
});

test("3: reconnecting does not erase history or silently restart an interrupted session", async () => {
  const a = harness();
  a.startSession(); a.tick(); a.startDemoTimer("R_100", false); a.stopDemoTimer();
  a.state.status = "live";
  await a.subscribeTicks("R_100");
  a.tick();
  assert.equal(a.state.history.length, 1);
  assert.equal(a.state.stats.unresolved, 1);
  assert.equal(a.state.session, "done");
  assert.equal(a.state.pos, null);
});

test("3: a stale subscription completion cannot reset the newly selected feed", async () => {
  const a = harness();
  let finish;
  a.state.pub.request = () => new Promise((r) => { finish = r; });
  const pending = a.subscribeTicks("R_100");
  a.state.settings.symbol = "R_25";
  a.state.lastTick = { symbol: "R_25", epoch: 2000 };
  finish({}); await pending;
  assert.equal(a.state.lastTick.symbol, "R_25");
});

test("4: generated display ticks never enter research or settle an existing real-data position", () => {
  const a = harness();
  a.startSession(); a.tick();
  a.startDemoTimer("R_100", false);
  [...a.intervals.values()][0]();
  assert.equal(a.state.demoFeed, true);
  assert.equal(a.state.stats.unresolved, 1);
  assert.equal(a.state.stats.trades, 0);
  assert.equal(a.state.stats.net, 0);
  assert.equal(a.state.freqQueue.length, 0);
  assert.equal(a.state.prices.length, 0);
  assert.equal(a.state.lastTick, null);
  assert.equal(a.state.trail.length, 1); // labelled display remains available
  assert.equal(a.elements.get("start-btn").disabled, true);
  a.startSession(); a.simulateTick(100.02, 2);
  assert.equal(a.state.session, "done");
  assert.equal(a.state.pos, null);
});

test("4: Start needs a valid live tick, not merely an open socket", () => {
  const a = harness();
  a.state.lastTick = null;
  a.renderControls(); a.startSession();
  assert.equal(a.elements.get("start-btn").disabled, true);
  assert.equal(a.state.session, "idle");
  a.tick(); a.startSession();
  assert.equal(a.state.session, "running");
});

test("4: late real frames are ignored while the synthetic display is active", () => {
  const a = harness();
  a.startDemoTimer("R_100", false);
  a.tick();
  assert.equal(a.state.trail.length, 0);
  assert.equal(a.state.freqQueue.length, 0);
});

for (const patch of [
  { symbol: "R_25" }, { symbol: undefined }, { quote: NaN }, { quote: Infinity },
  { quote: 0 }, { quote: -100 }, { pip_size: -1 }, { pip_size: 100 },
  { pip_size: 1.5 }, { pip_size: null }, { epoch: 0 }, { epoch: NaN },
  { quote: true }, { quote: [100.05] }, { pip_size: "" }, { pip_size: " " },
  { pip_size: false }, { pip_size: [] }, { epoch: [1004] },
]) {
  test(`5: rejects invalid/wrong-market tick ${JSON.stringify(patch)} before mutation`, () => {
    const a = harness();
    a.startSession(); a.tick();
    const before = plain({ trail: a.state.trail, freq: a.state.freq, prices: a.state.prices, pos: a.state.pos, stats: a.state.stats, lastPip: a.state.lastPip });
    a.tick(100.05, patch);
    assert.deepEqual(plain({ trail: a.state.trail, freq: a.state.freq, prices: a.state.prices, pos: a.state.pos, stats: a.state.stats, lastPip: a.state.lastPip }), before);
  });
}

test("5: duplicate and delayed ticks cannot settle a position or double-count observations", () => {
  const a = harness();
  a.startSession(); a.tick();
  a.onTick({ symbol: "R_100", quote: 100.05, pip_size: 2, epoch: 1002 });
  a.onTick({ symbol: "R_100", quote: 100.05, pip_size: 2, epoch: 1001 });
  assert.equal(a.state.freqQueue.length, 1);
  assert.equal(a.state.stats.trades, 0);
  assert.notEqual(a.state.pos, null);
  a.tick(100.02);
  assert.equal(a.state.stats.net, 9);
  assert.equal(a.state.stats.trades, 1);
});

test("5: valid numeric strings remain compatible with Deriv data", () => {
  const a = harness();
  a.startSession(); a.tick();
  a.tick("100.05", { pip_size: "2", epoch: "1004" });
  assert.equal(a.state.stats.trades, 1);
  assert.equal(a.state.stats.losses, 1);
  assert.equal(a.state.lastPip, 2);
});

test("5: a missing tick is unresolved, rather than using the wrong tick as a one-tick settlement", () => {
  const a = harness();
  a.startSession(); a.tick();
  a.tick(100.02, { epoch: 1006 });
  assert.equal(a.state.stats.trades, 0);
  assert.equal(a.state.stats.unresolved, 1);
  assert.equal(a.state.session, "done");
  assert.match(a.state.history[0].detail, /Missing live ticks/);
  assert.equal(a.state.freqQueue.length, 1);
});

test("5: one-second markets accept consecutive ticks and preserve trailing-zero digit precision", () => {
  const a = harness();
  a.state.settings.symbol = "1HZ100V";
  a.state.lastTick = { symbol: "1HZ100V", epoch: 1000 };
  a.startSession(); a.tick(123.40); a.tick(123.40);
  assert.equal(a.state.trail[0].digit, 0);
  assert.equal(a.state.stats.trades, 1);
  assert.equal(a.state.stats.unresolved, 0);
});

test("5: zero-decimal precision is accepted without substituting a different precision", () => {
  const a = harness();
  a.startSession(); a.tick(123, { pip_size: 0 }); a.tick(124, { pip_size: 0 });
  assert.equal(a.state.trail[0].digit, 4);
  assert.equal(a.state.lastPip, 0);
  assert.equal(a.state.stats.trades, 1);
});

test("6: Multiplier drawdown includes entry commission and open losses before settlement", () => {
  const a = harness();
  a.state.settings.product = "mult";
  a.startSession(); a.tick(100);
  assert.equal(a.state.stats.maxDD, 3.6);
  a.tick(99.8);
  assert.equal(a.state.stats.maxDD, 23.6);
  assert.equal(a.state.stats.net, 0);
  a.tick(100.05); a.tick(99.8);
  assert.equal(a.state.stats.maxDD, 25);
  a.tick(100.136);
  assert.equal(a.state.stats.net, 10);
  assert.equal(a.state.stats.maxDD, 25);
});

test("6: Accumulator drawdown retains the drop from accrued gains to knockout", () => {
  const a = harness();
  a.state.settings.product = "accu";
  a.startSession(); a.tick(100); a.tick(100); a.tick(100); a.tick(100.1);
  assert.equal(a.state.stats.net, -100);
  assert.equal(a.state.stats.maxDD, 106.09);
});

test("6: zero-profit Multiplier timeout is break-even everywhere, not a losing trade", () => {
  const a = harness();
  a.state.settings.product = "mult";
  a.state.multCommission["R_100:100"] = 0;
  a.startSession(); a.tick(100);
  for (let i = 0; i < 120; i++) a.tick(100);
  assert.equal(a.state.stats.trades, 1);
  assert.equal(a.state.stats.losses, 0);
  assert.equal(a.state.stats.wins, 0);
  assert.equal(a.state.stats.breakEven, 1);
  assert.equal(a.state.stats.net, 0);
  assert.equal(a.state.history[0].outcome, "break-even");
  assert.match(a.elements.get("last-trade").textContent, /BREAK-EVEN/);
  assert.match(a.elements.get("result-flash").innerHTML, /BREAK-EVEN/);
  assert.match(a.elements.get("trade-history-body").children[0].children[5].innerHTML, /Break-even/);
});

test("6: comparison uses the same break-even and equity-drawdown accounting", () => {
  const a = harness();
  const cfg = { product: "mult", stake: 100, tp: 10, mult: 100, dir: "up", commRate: 0 };
  const st = a.runBacktest(Array(221).fill(100), 2, "mult", cfg, {});
  assert.equal(st.trades, 1);
  assert.equal(st.breakEven, 1);
  assert.equal(st.losses, 0);
  assert.equal(st.unresolved, 0);
  const prices = [...Array(101).fill(100), 99.8, 100.05, 99.8, 100.136];
  const loss = a.runBacktest(prices, 2, "mult", { ...cfg, commRate: 0.00036 }, {});
  assert.equal(loss.net, 10);
  assert.equal(loss.maxDD, 25);
});

test("6: comparison reports the still-open final contract explicitly", () => {
  const a = harness();
  const st = a.runBacktest(Array(102).fill(100), 2, "accu", {
    product: "accu", stake: 100, tp: 10, growth: 0.03, barrier: 0.000537, maxTicks: 230,
  }, {});
  assert.equal(st.unresolved, 1);
  assert.equal(st.trades, 0);
  assert.equal(st.net, 0);
});

test("regression: a flat Multiplier still loses its existing $3.60 fallback commission", () => {
  const a = harness();
  a.state.settings.product = "mult";
  a.startSession(); a.tick(100);
  for (let i = 0; i < 120; i++) a.tick(100);
  assert.equal(a.state.stats.net, -3.6);
  assert.equal(a.state.stats.losses, 1);
});

test("regression: original strategy, payout, precision and filter functions are byte-for-byte unchanged", () => {
  const original = execFileSync("git", ["show", "d7974aeb48ecdc41a6c75a6a26ea5e2e5a605d41:frontend/public/app.js"], { cwd: root, encoding: "utf8" });
  const before = harness(original);
  const after = harness();
  for (const name of ["openContract", "stepContract", "lastDigit", "coldestDigit", "entryAllowed", "currentCfg", "clampStakeToProduct",
    "differsMultiplier", "accuParams", "multCommissionRate", "fetchContractInfo", "subscribeDigitPayouts", "applyDigitProposal"]) {
    assert.equal(after[name].toString(), before[name].toString(), `${name} changed`);
  }
  // Account transport is now server-side for actual Demo execution; strategy math stays identical.
});

test("regression: $100 Accumulator wins retain the original payouts at every growth rate", () => {
  const a = harness();
  for (const [growth, ticks, profit] of [[0.01, 10, 10.46], [0.02, 5, 10.41], [0.03, 4, 12.55], [0.04, 3, 12.49], [0.05, 2, 10.25]]) {
    const pos = a.openContract({ product: "accu", stake: 100, tp: 10, growth, barrier: 0.000537, maxTicks: 230 }, 100);
    let result;
    for (let i = 0; i < ticks; i++) result = a.stepContract(pos, 100, 0);
    assert.equal(pos.ticks, ticks);
    assert.equal(result.pnl, profit);
  }
});


test("virtual wallet rejects duplicate settlement and stake beyond available funds", () => {
  const a = harness(), pos = { stake: 100 };
  assert.equal(a.reserveVirtualStake(pos), true);
  assert.equal(a.virtualBalance().available, 900);
  assert.equal(a.reserveVirtualStake({stake:1}), false);
  assert.equal(a.settleVirtualStake(pos, 9), true);
  assert.equal(a.settleVirtualStake(pos, 9), false);
  assert.equal(a.virtualBalance().current, 1009);
  assert.equal(a.reserveVirtualStake({stake:1010}), false);
});

test("virtual persistence refuses corrupt balances and inconsistent outcome counts", () => {
  const a = harness();
  const saved = a.captureVirtualState();
  assert.equal(a.validateVirtualSnapshot(saved), true);
  assert.equal(a.validateVirtualSnapshot({...saved, wallet:{...saved.wallet, reserved:1001}}), false);
  assert.equal(a.validateVirtualSnapshot({...saved, stats:{...saved.stats, trades:1}}), false);
  assert.equal(a.validateVirtualSnapshot({...saved, wallet:{...saved.wallet, net:10}}), false);
});
