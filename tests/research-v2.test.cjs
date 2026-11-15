const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const R = require("../scripts/research-engine.cjs");
const root = path.resolve(__dirname, "..");
function fixture(n = 5000) {
  return { symbol: "R_100", prices: Array(n).fill(100.02), times: Array.from({ length: n }, (_, i) => 1700000000 + 2 * i), pip: 2 };
}
function quotes() {
  return Object.fromEntries(R.quoteSpecs("R_100", 100, { stake: 1 }).map(spec => [spec.key, R.quoteRecord(spec,
    { proposal: { ask_price: spec.request.amount, payout: spec.request.amount * (spec.kind === "binary" ? 1.5 : 0),
      commission: .04, contract_details: { tick_size_barrier: .0005, maximum_ticks: 230 } } }, 1)]));
}
function oldEngine() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(execFileSync("git", ["show", "17b50cfa:frontend/public/research.js"], { cwd: root, encoding: "utf8" }), sandbox);
  return sandbox.module.exports;
}

test("all 23 original benchmark payoff paths are preserved on identical inputs", () => {
  const before = oldEngine(), d = fixture(1000), q = quotes();
  d.prices = d.prices.map((_, i) => 100 + ((i * 13) % 100) / 100);
  for (const s of before.strategies) {
    const a = before.simulate(d, q, s.id, { stake: 1, balance: 1000 });
    const b = R.simulate(d, q, s.id, { stake: 1, balance: 1000 });
    for (const key of ["net", "wins", "losses", "trades", "maxDD", "maxLossStreak", "available", "equity"]) assert.equal(b[key], a[key], s.id + " " + key);
  }
});

test("boolean, blank and array monetary fields are not accepted as quotes", () => {
  const spec = R.quoteSpecs("R_100", 100, { stake: 1 })[0];
  for (const ask of [true, false, "", [], null, Infinity]) assert.equal(R.quoteRecord(spec, { proposal: { ask_price: ask, payout: 2 } }, 1), null);
  assert.equal(R.quoteRecord(spec, { proposal: { ask_price: "1", payout: "1.5" } }, 1).ask, 1);
});

test("a quote for a different stake cannot silently enter the requested scenario", () => {
  const spec = R.quoteSpecs("R_100", 100, { stake: 1 })[0];
  assert.equal(R.quoteRecord(spec, { proposal: { ask_price: 2, payout: 3 } }, 1), null);
});

test("break-even uses unrounded mean returns rather than rounding each average first", () => {
  const d = fixture(1000), q = quotes();
  q["differs:5"].payout = 1.03; d.prices[208] = 100.05;
  const r = R.simulate(d, q, "diff-fixed", { stake: .35, balance: 10, staking: "paroli2" }, 200, 209);
  assert.equal(r.wins, 2); assert.equal(r.losses, 1);
  assert.ok(Math.abs(r.empiricalBreakEven - .35 / (.015 + .35)) < 1e-10);
  assert.ok(Math.abs(r.empiricalBreakEven - .35 / (.02 + .35)) > .01);
});

test("adverse-price scenario can only reduce binary profit, never inflate a payout", () => {
  const d = fixture(1000), q = quotes();
  const base = R.simulate(d, q, "diff-fixed", { stake: 1, balance: 1000 }, 200, 230);
  const stress = R.simulate(d, q, "diff-fixed", { stake: 1, balance: 1000, winningReturnHaircut: .025 }, 200, 230);
  assert.ok(stress.net < base.net); assert.equal(stress.trades, base.trades);
  assert.ok(stress.history.every((h, i) => h.pnl <= base.history[i].pnl));
  assert.match(stress.pricingScenario, /not an asserted fee/);
});

test("a loss followed by a doubled-stake win can still lose money under Martingale", () => {
  const d = fixture(1000), q = quotes(); q["differs:5"].payout = 1.09; d.prices[202] = 100.05;
  const r = R.simulate(d, q, "diff-fixed", { stake: 1, balance: 10, staking: "martingale3" }, 200, 206);
  assert.equal(r.wins, 1); assert.equal(r.losses, 1); assert.equal(r.net, -.82);
});

test("a tiny favourable sample produces NO TRADE with an explicit sample-size reason", () => {
  const report = R.compare(fixture(1000), quotes(), { stake: 1, balance: 1000 });
  assert.equal(report.decision, "NO TRADE"); assert.equal(report.selectedExposure, 0); assert.equal(report.staking.length, 0);
  assert.ok(report.rows.find(r => r.id === "diff-fixed").assessment.reasons.includes("insufficient validation trades"));
});

test("a constructed strong positive control can qualify; NO TRADE is not hard-coded", () => {
  const report = R.compare(fixture(), quotes(), { stake: 1, balance: 1000 });
  assert.notEqual(report.selected, null);
  assert.equal(report.decision, "RESEARCH CANDIDATE ONLY");
  assert.ok(report.rows.find(r => r.id === report.selected).assessment.lowerBound > 0);
});

test("holdout mutations cannot alter eligibility, ranking, or the candidate", () => {
  const a = fixture(), b = fixture();
  for (let i = 3000; i < 5000; i++) b.prices[i] = 100.05;
  const left = R.compare(a, quotes(), { stake: 1, balance: 1000 }), right = R.compare(b, quotes(), { stake: 1, balance: 1000 });
  assert.equal(left.selected, right.selected);
  assert.equal(JSON.stringify(left.rows.map(r => r.assessment)), JSON.stringify(right.rows.map(r => r.assessment)));
  assert.notEqual(left.rows.find(r => r.id === "diff-fixed").holdout.net, right.rows.find(r => r.id === "diff-fixed").holdout.net);
});

test("multiple-comparison bound weakens with more comparisons and with fewer observations", () => {
  const h = Array.from({ length: 100 }, () => ({ stake: 1, pnl: .5 }));
  assert.ok(R.returnLowerBound(h, 1.5, 100) < R.returnLowerBound(h, 1.5, 32));
  assert.ok(R.returnLowerBound(h.slice(0, 50), 1.5) < R.returnLowerBound(h, 1.5));
});

test("small wallets cannot qualify by hiding their full-stake exposure behind a planned stop", () => {
  const report = R.compare(fixture(), quotes(), { stake: .35, balance: 1 });
  assert.equal(report.decision, "NO TRADE");
  assert.ok(report.rows.every(r => r.assessment.reasons.some(s => s.includes("full-stake exposure"))));
});

test("progressive stakes cannot qualify a model for selection", () => {
  const report = R.compare(fixture(), quotes(), { stake: 1, balance: 1000, staking: "martingale3" });
  assert.equal(report.decision, "NO TRADE");
  assert.ok(report.rows.every(r => r.assessment.reasons.some(s => s.includes("progressive staking"))));
});

test("new evidence gates use past observations and abstain without evidence", () => {
  const d = fixture(), q = quotes(), ds = d.prices.map(p => R.digit(p, 2)), ind = R.indicators(d.prices);
  const s = R.strategies.find(s => s.id === "diff-evidence");
  const first = R.signal(s, 200, d, ds, ind, {}, q);
  ds[4999] = 9;
  assert.equal(JSON.stringify(first), JSON.stringify(R.signal(s, 200, d, ds, ind, {}, q)));
  const uniform = Array.from({ length: 5000 }, (_, i) => i % 10);
  q["differs:0"].payout = 1.09; // Realistic weak payout; a 1.5x positive-control quote would imply a genuine toy edge.
  assert.equal(R.signal(s, 200, d, uniform, ind, {}, q), null);
});

test("virtual rebuild cannot change Demo account configuration or order code", () => {
  for (const file of ["backend/lib/deriv_demo.py", "backend/routers/deriv.py"]) {
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), execFileSync("git", ["show", "a5556bc:" + file], { cwd: root, encoding: "utf8" }));
  }
  const app = fs.readFileSync(path.join(root, "frontend/public/app.js"), "utf8");
  assert.doesNotMatch(app, /digit_mode:\s*["']cold/);
});

test("implemented screening constants match the predeclared protocol", () => {
  const p = JSON.parse(fs.readFileSync(path.join(root, "research/protocol-v2.json"))).criteria;
  assert.equal(R.POLICY.minTraining, p.minimum_training_trades); assert.equal(R.POLICY.minValidation, p.minimum_validation_trades);
  assert.equal(R.POLICY.alpha, p.familywise_alpha); assert.equal(R.POLICY.maxStakeFraction, p.maximum_full_stake_fraction);
  assert.equal(R.POLICY.stressHaircut, p.winning_return_haircut_fraction_of_stake);
});

test("corrected random reference covers all ten digits on two-second epochs; legacy parity bias stays visible", () => {
  const d = fixture(1000), ds = d.prices.map(p => R.digit(p, 2)), ind = R.indicators(d.prices);
  const old = R.strategies.find(s => s.id === "diff-random"), next = R.strategies.find(s => s.id === "diff-random-v2");
  const a = new Set(), b = new Set();
  for (let i = 200; i < 1000; i++) { a.add(R.signal(old, i, d, ds, ind, {}).digit); b.add(R.signal(next, i, d, ds, ind, {}).digit); }
  assert.ok(a.size <= 5); assert.ok([...a].every(digit => digit % 2 === 1)); assert.equal(b.size, 10);
});

test("no evidence bound is produced for a fabricated return outside the quoted payoff support", () => {
  assert.equal(R.returnLowerBound([{ stake: 1, pnl: 9 }], 1.5), null);
  assert.equal(R.returnLowerBound([{ stake: 0, pnl: 1 }], 1.5), null);
});

test("positive totals cannot conceal a failed chronological validation block", () => {
  const report = R.compare(fixture(), quotes(), { stake: 1, balance: 1000 });
  const row = report.rows.find(r => r.id === "diff-fixed");
  for (const h of row.validation.history) if (h.signalIndex >= 2750) h.pnl = -1;
  const assessed = R.assess(row, { stake: 1, balance: 1000 });
  assert.equal(assessed.eligible, false);
  assert.ok(assessed.reasons.some(r => r.includes("every chronological validation block")));
});
