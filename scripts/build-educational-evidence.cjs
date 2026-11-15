/* Build display-only category evidence from the preserved, fixed-protocol evaluation. */
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
if (!fs.existsSync(path.join(root, "research/results-v2.json"))) execFileSync(process.execPath, ["scripts/evaluate-v2.cjs"], { cwd: root, stdio: "ignore" });
const report = JSON.parse(fs.readFileSync(path.join(root, "research/results-v2.json")));
const saved = JSON.parse(fs.readFileSync(path.join(root, "research/public-sample.json")));
const definitions = [
  ["differs", "Digit Differs", "diff-fixed", "differs:5", .9, "Wins if the final digit differs from the selected digit. Under independent uniform digits, the theoretical win probability is 90%."],
  ["accu", "Accumulator", "accu", "accu", null, "Virtual growth continues while each observed tick stays inside the modeled barrier. A breach loses the stake. Growth and barrier assumptions are not a guaranteed payout."],
  ["mult", "Multiplier", "mult", "mult:down", null, "Virtual P/L follows direction, price move and leverage, minus the saved commission. The exit value is variable; an intended stop can slip at the next observed tick."],
  ["matches", "Digit Matches", "match-fixed", "matches:5", .1, "Wins if the final digit matches the selected digit. Under independent uniform digits each digit has a theoretical 10% probability; frequent past digits do not prove a prediction."],
  ["touch", "Touch", "touch", "touch", .5, "Wins if the observed price reaches the specified upper barrier at any point during 120 seconds. Probability depends on barrier distance, duration and price behaviour; 50% below is only an illustration."],
  ["notouch", "No Touch", "notouch", "notouch", .5, "Wins if the observed price never reaches the specified upper barrier during 120 seconds. This is a separate outcome condition from Touch; 50% below is only an illustration."],
];
const round = n => Math.round(n * 100) / 100;
const categories = definitions.map(([id, name, benchmark, quoteKey, probability, description]) => {
  const models = report.evaluation.map(c => c.models.find(m => m.id === benchmark));
  const n = models.reduce((s, m) => s + m.test.trades, 0), wins = models.reduce((s, m) => s + m.test.wins, 0), losses = models.reduce((s, m) => s + m.test.losses, 0);
  const net = round(models.reduce((s, m) => s + m.test.net, 0));
  const prices = saved.markets.map(m => {
    const row = m.quotes.large.find(q => q.spec.key === quoteKey), p = row?.response?.proposal;
    if (!p || row.error) return { symbol: m.symbol, unavailable: true, reason: row?.error?.message || "No verified proposal/model data" };
    const ask = Number(p.ask_price), payout = Number(p.payout), binary = row.spec.kind === "binary";
    const gross = binary ? round(10 * payout / ask) : null, profit = binary ? round(gross - 10) : null;
    return { symbol: m.symbol, source: "Saved public proposal scenario; not a historical executable quote", capturedAt: row.capturedAt,
      originalQuoteStake: ask, originalQuotePayout: binary ? payout : null, hypotheticalStake: 10,
      gross, profit, maxLoss: 10, breakEven: binary ? 10 / gross : null,
      probabilityAssumption: probability, expectedValue: binary ? round(probability * profit - (1 - probability) * 10) : null,
      barrier: row.spec.request.barrier || p.contract_details?.tick_size_barrier || null,
      durationSeconds: row.spec.request.duration_unit === "s" ? row.spec.request.duration : null,
      growthRate: row.spec.request.growth_rate || null, multiplier: row.spec.request.multiplier || null,
      commission: row.spec.kind === "mult" ? round(10 * Number(p.commission) / ask) : null };
  });
  return { id, name, benchmark, description, hypotheticalStake: 10, prices, trades: n, wins, losses, winRate: n ? wins / n : null,
    net, meanReturn: n ? net / n : null, maxDrawdown: Math.max(...models.map(m => m.test.maxDD)),
    observedAverageWinRange: models.map(m => m.test.averageWin).filter(n => n != null),
    observedAverageLossRange: models.map(m => m.test.averageLoss).filter(n => n != null),
    empiricalBreakEven: models.map(m => m.test.empiricalBreakEven).filter(n => n != null),
    activeWindows: models.filter(m => m.test.trades).length, positiveWindows: models.filter(m => m.test.net > 0).length,
    qualifiedWindows: models.filter(m => m.assessment.eligible).length,
    verdict: n && net < 0 ? "FAILED" : "INCONCLUSIVE",
    limitations: "Four independent historical test windows. Saved public pricing and modeled fills are assumptions; no forward profitability or account execution is supported. Unavailable quotes are excluded, not replaced. Positive totals alone do not pass the research criteria." };
});
const output = { version: 1, source: "PR #7 fixed-protocol evaluation; benchmark category summaries only", frozenCommit: report.provenance.frozen_commit,
  evaluationSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "research/unseen-v2.json.gz"))).digest("hex"),
  historicalFindings: { testsPassed: 166, ticks: 20000, originalBenchmarks: 23, addedAlternatives: 7, oldSelectorNet: -226.39, rebuiltDecision: "NO TRADE", touchNet: 23.50, touchTrades: 95, qualifiedStrategies: 0 }, categories };
fs.writeFileSync(path.join(root, "frontend/public/research-evidence.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ categories: categories.map(c => ({ id: c.id, net: c.net, n: c.trades, verdict: c.verdict })), historicalFindings: output.historicalFindings }));
