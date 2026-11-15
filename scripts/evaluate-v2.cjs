// Deterministic virtual-only comparison. No network, credentials or order APIs.
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const R = require("./research-engine.cjs"), root = path.resolve(__dirname, "..");
const protocol = JSON.parse(fs.readFileSync(path.join(root, "research/protocol-v2.json")));
const saved = JSON.parse(fs.readFileSync(path.join(root, "research/public-sample.json")));
const sandbox = { module: { exports: {} } };
vm.runInNewContext(execFileSync("git", ["show", "17b50cfa:frontend/public/research.js"], { cwd: root, encoding: "utf8" }), sandbox);
const before = sandbox.module.exports;
const compact = r => ({ trades: r.trades, wins: r.wins, losses: r.losses, net: r.net, maxDD: r.maxDD, averageWin: r.averageWin,
  averageLoss: r.averageLoss, rewardRisk: r.rewardRisk, empiricalBreakEven: r.empiricalBreakEven, quotedBreakEven: r.quotedBreakEven,
  maxLossStreak: r.maxLossStreak, status: r.status });
function scenario(data, options, quoteLabel, role) {
  const market = saved.markets.find(m => m.symbol === data.symbol), quotes = {};
  for (const row of market.quotes[quoteLabel]) if (row.response) {
    const q = R.quoteRecord(row.spec, row.response, row.capturedAt); if (q) quotes[q.key] = q;
  }
  const old = before.compare(data, quotes, options), next = R.compare(data, quotes, options);
  const chosen = (report) => report.selected ? compact(report.rows.find(r => r.id === report.selected).holdout) : { trades: 0, net: 0, maxDD: 0 };
  return { role, symbol: data.symbol, period: next.period, options, observations: data.prices.length,
    before: { selected: old.selected, result: chosen(old) }, after: { decision: next.decision, selected: next.selected, selectedExposure: next.selectedExposure, result: chosen(next) },
    models: next.rows.map(r => ({ id: r.id, name: r.name, benchmark: r.benchmark, classification: r.classification,
      training: compact(r.training), validation: compact(r.validation), test: compact(r.holdout),
      assessment: r.assessment, adverseValidation: compact(r.stressValidation) })) };
}
const development = [];
for (const m of saved.markets) for (const d of m.periods) {
  for (const balance of [1, 2.5, 5, 8, 10]) development.push(scenario(d, { balance, stake: .35 }, "small", "Previously inspected development"));
  development.push(scenario(d, { balance: 1000, stake: 50 }, "large", "Previously inspected development"));
}
const freshPath = path.join(root, "research/unseen-v2.json.gz");
const evaluation = [];
let provenance = null;
if (fs.existsSync(freshPath)) {
  const fresh = JSON.parse(zlib.gunzipSync(fs.readFileSync(freshPath)));
  const hash = file => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
  if (hash("research/protocol-v2.json") !== fresh.protocol_sha256 || hash("frontend/public/research.js") !== fresh.engine_sha256) {
    throw new Error("Protocol/engine changed after evaluation capture. Results cannot be presented as the frozen unseen test.");
  }
  provenance = { frozen_commit: fresh.frozen_commit, protocol_sha256: fresh.protocol_sha256, engine_sha256: fresh.engine_sha256, role: fresh.role };
  for (const d of fresh.periods) evaluation.push(scenario(d, protocol.evaluation_wallet, "large", "New fixed-protocol historical evaluation"));
}
const report = { policy: R.POLICY, caveat: R.CAVEAT, provenance, development, evaluation };
fs.writeFileSync(path.join(root, "research/results-v2.json"), JSON.stringify(report) + "\n");
const totals = rows => ({ cases: rows.length, beforeNet: R.cents(rows.reduce((s, c) => s + c.before.result.net, 0)),
  afterNet: R.cents(rows.reduce((s, c) => s + c.after.result.net, 0)), noTrade: rows.filter(c => c.after.decision === "NO TRADE").length });
console.log(JSON.stringify({ development: totals(development), developmentLarge: totals(development.filter(c => c.options.balance === 1000)),
  evaluation: totals(evaluation), models: evaluation.map(c => ({ symbol: c.symbol, period: c.period, before: c.before, after: c.after,
    changed: c.models.filter(m => m.benchmark).map(m => ({ id: m.id, classification: m.classification, test: m.test })) })) }, null, 2));
