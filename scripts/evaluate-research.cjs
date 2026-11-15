/* Reproduce the report offline from captured public data; no orders or network. */
const fs = require("node:fs");
const path = require("node:path");
const R = require("./research-engine.cjs");
const root = path.resolve(__dirname, "..");
const input = JSON.parse(fs.readFileSync(process.argv[2] || path.join(root, "research/public-sample.json"), "utf8"));
const results = [];
const compact = (r) => ({ id: r.id, trades: r.trades, wins: r.wins, losses: r.losses, net: r.net, maxDD: r.maxDD,
  averageWin: r.averageWin, averageLoss: r.averageLoss, empiricalBreakEven: r.empiricalBreakEven,
  quotedBreakEven: r.quotedBreakEven, maxLossStreak: r.maxLossStreak, available: r.available,
  equity: r.equity, unresolved: r.unresolved, status: r.status });
for (const market of input.markets) {
  for (const [label, stake, balances] of [["small", .35, [1, 2.5, 5, 8, 10]], ["large", 50, [1000]]]) {
    const quotes = {};
    for (const row of market.quotes[label]) {
      if (!row.response) continue;
      const q = R.quoteRecord(row.spec, row.response, row.capturedAt);
      if (q) quotes[q.key] = q;
    }
    for (const data of market.periods) for (const balance of balances) {
      const report = R.compare(data, quotes, { stake, balance, direction: "down" });
      results.push({ symbol: data.symbol, period: report.period, balance, stake, selected: report.selected,
        selectionNote: report.selectionNote, stakingReference: report.stakingReference,
        rows: report.rows.map(row => ({ id: row.id, name: row.name, training: compact(row.training),
          validation: compact(row.validation), holdout: compact(row.holdout) })), staking: report.staking.map(compact) });
    }
  }
}
const output = { captured_at: input.captured_at, caveat: R.CAVEAT, results };
fs.writeFileSync(path.join(root, "research/results.json"), JSON.stringify(output) + "\n");
console.log(JSON.stringify({ cases: results.length, selected_on_validation: results.filter(r => r.selected).length,
  large_account_holdouts: results.filter(r => r.balance === 1000).map(r => ({ symbol: r.symbol, period: r.period, selected: r.selected,
    rows: r.rows.filter(v => ["diff-fixed", "accu", "mult", "mult-risk"].includes(v.id)).map(v => ({ id: v.id, ...v.holdout })) })) }, null, 2));
