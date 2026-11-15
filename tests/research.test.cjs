const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const R = require("../scripts/research-engine.cjs");

function data(price = 100.02, n = 1000) {
  return { symbol: "R_100", pip: 2, prices: Array(n).fill(price), times: Array.from({ length: n }, (_, i) => 1700000000 + i * 2) };
}
function quotes(stake = 100) {
  const records = {};
  for (const spec of R.quoteSpecs("R_100", 100, { stake, mult: 100 })) {
    const ratio = spec.key.startsWith("matches") ? 9 : spec.key.startsWith("differs") ? 1.1255 : 1.9;
    const q = R.quoteRecord(spec, { proposal: { ask_price: spec.request.amount, payout: spec.request.amount * ratio,
      commission: spec.request.amount * .036, contract_details: { tick_size_barrier: .0005, maximum_ticks: 230 } } }, 1700000000);
    records[q.key] = q;
  }
  return records;
}

test("high win rate does not conceal a negative payoff: five $12.55 wins and two $100 losses", () => {
  const d = data(); d.prices[217] = 100.05; d.prices[220] = 100.05;
  const r = R.simulate(d, quotes(), "diff-fixed", { stake: 100, balance: 1000 }, 200, 221);
  assert.equal(r.wins, 5); assert.equal(r.losses, 2);
  assert.equal(r.net, -137.25); assert.equal(r.available, 862.75); assert.equal(r.maxDD, 200);
  assert.ok(Math.abs(r.quotedBreakEven[0] - 100 / 112.55) < 1e-10);
});

test("signals wait for a subsequent fill tick, then a subsequent settlement; no future tick chooses the digit", () => {
  const d = data();
  const r = R.simulate(d, quotes(), "diff-cold25", { stake: 1, balance: 10 }, 200, 209);
  assert.equal(r.history[0].signal, d.times[200]); assert.equal(r.history[0].entry, d.times[201]);
  assert.equal(r.history[0].exit, d.times[202]);
  assert.ok(r.history.every((row, i) => i === 0 || row.signal > r.history[i - 1].exit));
  const changed = structuredClone(d); changed.prices[800] = 999999.95;
  const same = R.simulate(changed, quotes(), "diff-cold25", { stake: 1, balance: 10 }, 200, 209);
  assert.equal(JSON.stringify(r.history), JSON.stringify(same.history));
});

test("changing every holdout price cannot change validation selection", () => {
  const a = data();
  for (let i = 0; i < a.prices.length; i++) a.prices[i] = 100 + ((i * 7) % 10) / 100;
  const b = structuredClone(a); for (let i = 600; i < 1000; i++) b.prices[i] = 99.95;
  const left = R.compare(a, quotes(), { stake: 1, balance: 1000 });
  const right = R.compare(b, quotes(), { stake: 1, balance: 1000 });
  assert.equal(left.selected, right.selected);
  assert.equal(JSON.stringify(left.rows.map(r => r.validation)), JSON.stringify(right.rows.map(r => r.validation)));
});

test("complete-phase buffers avoid an unresolved tail suppressing every candidate by construction", () => {
  const report = R.compare(data(), quotes(), { stake: 1, balance: 1000 });
  assert.notEqual(report.selected, null);
  assert.equal(report.rows.find(r => r.id === "diff-fixed").validation.unresolved, 0);
  assert.ok(report.rows.every(r => r.holdout.unresolved === 0));
});

test("a $1 virtual wallet cannot create credit, invent a subminimum Accumulator, or afford a $2 progression", () => {
  const r = R.simulate(data(), quotes(), "diff-fixed", { stake: .35, balance: 1 });
  assert.ok(r.available >= 0 && r.history.every(row => row.balance >= 0));
  const accu = R.simulate(data(), quotes(), "accu", { stake: .35, balance: 1 });
  assert.equal(accu.trades, 0); assert.match(accu.stopped, /limits/);
  const progression = R.simulate(data(), quotes(), "diff-fixed", { stake: 1, balance: 1, staking: "paroli3" });
  assert.equal(progression.trades, 1); assert.match(progression.stopped, /insufficient/);
});

test("loss budgets reserve full contract exposure before entry, not just a planned stop", () => {
  const r = R.simulate(data(100.05), quotes(), "diff-fixed", { stake: .35, balance: 1, maxLoss: .5 });
  assert.equal(r.losses, 1); assert.equal(r.net, -.35); assert.match(r.stopped, /breach/);
  const trending = data(); trending.prices = trending.prices.map((_, i) => 100 + i * .001);
  const mult = R.simulate(trending, quotes(), "mult-risk", { stake: 10, balance: 100, maxLoss: 1 });
  assert.equal(mult.trades, 0); assert.match(mult.stopped, /breach/);
});

test("session target ends the virtual session before another stake is reserved", () => {
  const r = R.simulate(data(), quotes(), "diff-fixed", { stake: 100, balance: 1000, target: 10 });
  assert.equal(r.trades, 1); assert.equal(r.net, 12.55); assert.equal(r.available, 1012.55); assert.equal(r.unresolved, 0);
});

test("capped Martingale loses seven base stakes in three losses; no automatic recovery fiction", () => {
  const r = R.simulate(data(100.05), quotes(), "diff-fixed", { stake: 1, balance: 7, staking: "martingale3" });
  assert.equal(JSON.stringify(r.history.map(v => v.stake)), JSON.stringify([1, 2, 4]));
  assert.equal(r.net, -7); assert.equal(r.available, 0); assert.equal(r.maxLossStreak, 3);
});

test("Paroli resets after two or three wins, and a loss discards its larger stake", () => {
  for (const steps of [2, 3]) {
    const r = R.simulate(data(), quotes(), "diff-fixed", { stake: 1, balance: 100, staking: "paroli" + steps }, 200, 215);
    assert.equal(r.history[steps].stake, 1);
    assert.equal(r.history[steps - 1].stake, 2 ** (steps - 1));
  }
});

test("Over 1 excludes 1 and Under 8 excludes 8; a prior 0/1 streak alone does not determine the next digit", () => {
  for (const [id, price, expected] of [["over", 100.01, -1], ["over", 100.02, .9], ["under", 100.08, -1], ["under", 100.07, .9]]) {
    const r = R.simulate(data(price), quotes(), id, { stake: 1, balance: 100 }, 200, 203);
    assert.equal(r.net, expected);
  }
  const d = data(100.00); d.prices[202] = 100.01;
  const filtered = R.simulate(d, quotes(), "over-filter", { stake: 1, balance: 10 }, 200, 203);
  assert.equal(filtered.net, -1);
});

test("Matches agreement requires all three historical windows to choose the same digit", () => {
  const d = data(100.03), ds = d.prices.map(p => R.digit(p, d.pip));
  const s = R.strategies.find(s => s.id === "match-agree");
  assert.equal(R.signal(s, 200, d, ds, R.indicators(d.prices), {}).digit, 3);
  ds.fill(8, 0, 140);
  assert.equal(R.signal(s, 200, d, ds, R.indicators(d.prices), {}), null);
});

test("EMA and Wilder RSI have known flat and monotonic limits and are prefix invariant", () => {
  const flat = R.indicators(Array(30).fill(10)); assert.equal(flat[29].rsi, 50);
  const up = R.indicators(Array.from({ length: 40 }, (_, i) => i + 1)); assert.equal(up[39].rsi, 100); assert.ok(up[39].e9 > up[39].e21);
  const down = R.indicators(Array.from({ length: 40 }, (_, i) => 100 - i)); assert.equal(down[39].rsi, 0);
  assert.equal(JSON.stringify(up.slice(0, 20)), JSON.stringify(R.indicators(Array.from({ length: 20 }, (_, i) => i + 1))));
});

test("plain Rise/Fall ties lose; allow-equals contracts are not silently substituted", () => {
  const r = R.simulate(data(), quotes(), "rise-fixed", { stake: 1, balance: 10 }, 200, 207);
  assert.equal(r.losses, 1); assert.equal(r.net, -1);
});

test("Touch includes exact barrier contact and No Touch fails on contact before expiry", () => {
  const d = data(100); d.prices[202] = 100.1;
  for (const [id, expected] of [["touch", .9], ["notouch", -1]]) {
    const r = R.simulate(d, quotes(), id, { stake: 1, balance: 10 }, 200, 203);
    assert.equal(r.net, expected);
  }
  const expiry = R.simulate(data(100), quotes(), "notouch", { stake: 1, balance: 10 }, 200, 262);
  assert.equal(expiry.net, .9);
});

test("Accumulator breaches use adjacent spot prices and do not award growth on a knockout", () => {
  const d = data(100); d.prices[202] = 100.1;
  const r = R.simulate(d, quotes(), "accu", { stake: 10, balance: 100 }, 200, 203);
  assert.equal(r.net, -10); assert.equal(r.wins, 0);
});

test("Multiplier commission appears in equity immediately and is charged once at a flat timeout", () => {
  const r = R.simulate(data(100), quotes(), "mult", { stake: 100, balance: 1000 }, 200, 322);
  assert.equal(r.net, -3.6); assert.equal(r.losses, 1); assert.equal(r.maxDD, 3.6);
});

test("an intended 10% Multiplier stop uses the observed gap loss, not a perfect fictional fill", () => {
  const d = data(100);
  for (let i = 0; i <= 200; i++) d.prices[i] = 100 + i * .001;
  d.prices[201] = 100; d.prices[202] = 99.87;
  const r = R.simulate(d, quotes(), "mult-risk", { stake: 100, balance: 1000 }, 200, 203);
  assert.equal(r.net, -16.6); // -13 price move and $3.60 commission
  assert.ok(r.net < -10 && r.net >= -100);
});

test("an incomplete binary contract is reserved and unknown, never counted as a win", () => {
  const r = R.simulate(data(), quotes(), "diff-fixed", { stake: 1, balance: 10 }, 200, 202);
  assert.equal(r.available, 9); assert.equal(r.unresolved, 1); assert.equal(r.trades, 0); assert.equal(r.openPnl, null);
});

test("missing quotes, malformed prices and historical gaps cannot create results", () => {
  const noQuotes = R.simulate(data(), {}, "diff-fixed", { stake: 1, balance: 10 });
  assert.equal(noQuotes.trades, 0); assert.match(noQuotes.status, /no verified/);
  for (const change of [d => d.prices[201] = NaN, d => d.times[201] += 1, d => d.pip = null]) {
    const d = data(); change(d); assert.throws(() => R.simulate(d, quotes(), "diff-fixed"));
  }
});

test("NO TRADE has no fallback strategy or staking projection when nothing qualifies", () => {
  const report = R.compare(data(), {}, { stake: 1, balance: 10 });
  assert.equal(report.decision, "NO TRADE");
  assert.equal(report.selected, null); assert.equal(report.stakingReference, null);
  assert.equal(report.staking.length, 0);
  assert.match(report.selectionNote, /No fallback strategy/);
  assert.ok(report.rows.every(row => row.holdout.trades === 0 && row.holdout.available === 10));
});

test("quote records reject missing commissions and payout models instead of inventing defaults", () => {
  const specs = R.quoteSpecs("R_100", 100);
  assert.equal(R.quoteRecord(specs.find(q => q.key === "mult:up"), { proposal: { ask_price: 1 } }, 1), null);
  assert.equal(R.quoteRecord(specs[0], { proposal: { ask_price: .35, payout: 0 } }, 1), null);
  assert.equal(R.quoteRecord(specs.find(q => q.key === "accu"), { proposal: { ask_price: 1 } }, 1), null);
});

test("every captured period is reproducible and wallet ledger reconciles across multiple balances", () => {
  const captured = JSON.parse(fs.readFileSync(require.resolve("../research/public-sample.json"), "utf8"));
  for (const m of captured.markets) {
    for (let i = 0; i < m.periods.length; i++) {
      const p = m.periods[i];
      assert.ok(p.times.at(-1) <= p.requested_end && p.times[0] >= p.requested_end - 2000);
      if (i) assert.ok(m.periods[i - 1].times.at(-1) < p.times[0], "dated samples must not overlap");
    }
    const qs = {};
    for (const row of m.quotes.small) if (row.response) { const q = R.quoteRecord(row.spec, row.response, row.capturedAt); if (q) qs[q.key] = q; }
    for (const d of m.periods) for (const balance of [1, 2.5, 5, 8, 10]) {
      const report = R.compare(d, qs, { stake: .35, balance });
      for (const row of report.rows) {
        const r = row.holdout;
        assert.ok(r.available >= 0);
        assert.equal(r.net, R.cents(r.history.reduce((n, v) => n + v.pnl, 0)));
        assert.equal(r.available, R.cents(balance + r.net - (r.openStake || 0)));
        assert.equal(r.trades, r.wins + r.losses + r.breakEven);
      }
    }
  }
});

test("research module has no order or credential transport", () => {
  const source = fs.readFileSync(require.resolve("../frontend/public/research.js"), "utf8");
  assert.doesNotMatch(source, /\b(fetch|WebSocket|localStorage|sessionStorage)\s*[.(]/);
  for (const spec of R.quoteSpecs("R_100", 100)) {
    assert.equal(spec.request.proposal, 1);
    assert.ok(!("buy" in spec.request) && !("sell" in spec.request) && !("authorize" in spec.request));
  }
});
