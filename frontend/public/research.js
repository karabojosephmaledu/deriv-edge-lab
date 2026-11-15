/* Virtual research only. No account credentials, network access or order functions.
 * Current proposals applied to earlier prices are assumptions, not historical quotes.
 */
(function (root) {
  "use strict";
  const cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  const numeric = v => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v)) ? Number(v) : null;
  const digit = (p, pip) => Number(p.toFixed(pip).slice(-1));
  const MIN = { binary: .35, accu: 1, mult: 1 };
  const MAX = { binary: 5000, accu: 200, mult: 500 };
  const CAVEAT = "Virtual estimates using current proposals on historical prices. These are not historical executable quotes. No proven edge; no automatic strategy promotion. Small samples and multiple comparisons can mislead.";
  const POLICY = Object.freeze({ minTraining: 100, minValidation: 100, maxStakeFraction: .02, maxDrawdownFraction: .2,
    blocks: 4, minBlockTrades: 20, alpha: .05, minComparisons: 32, stressHaircut: .025 });

  function lowerWinRate(wins, n, z = 3.5) {
    if (!n) return 0;
    const p = wins / n, z2 = z * z;
    return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n));
  }

  function quoteSpecs(symbol, reference, options = {}) {
    const stake = options.stake ?? .35;
    if (!positive(stake) || !positive(reference)) throw new Error("Invalid quote inputs");
    const out = [];
    const add = (key, type, extra = {}, kind = "binary") => out.push({ key, kind, minStake: MIN[kind], maxStake: MAX[kind],
      request: { proposal: 1, amount: Math.max(MIN[kind], stake), basis: "stake", currency: "USD", underlying_symbol: symbol, contract_type: type, ...extra } });
    for (let d = 0; d < 10; d++) {
      add("differs:" + d, "DIGITDIFF", { barrier: String(d), duration: 1, duration_unit: "t" });
      add("matches:" + d, "DIGITMATCH", { barrier: String(d), duration: 1, duration_unit: "t" });
    }
    add("over", "DIGITOVER", { barrier: "1", duration: 1, duration_unit: "t" });
    add("under", "DIGITUNDER", { barrier: "8", duration: 1, duration_unit: "t" });
    add("rise", "CALL", { duration: 5, duration_unit: "t" });
    add("fall", "PUT", { duration: 5, duration_unit: "t" });
    const offset = Math.max(.01, cents(reference * .001));
    add("touch", "ONETOUCH", { barrier: "+" + offset.toFixed(2), duration: 120, duration_unit: "s" });
    add("notouch", "NOTOUCH", { barrier: "+" + offset.toFixed(2), duration: 120, duration_unit: "s" });
    add("accu", "ACCU", { growth_rate: options.growth ?? .03 }, "accu");
    add("mult:up", "MULTUP", { multiplier: options.mult ?? 100 }, "mult");
    add("mult:down", "MULTDOWN", { multiplier: options.mult ?? 100 }, "mult");
    return out;
  }

  function quoteRecord(spec, response, capturedAt) {
    const p = response.proposal || {};
    const ask = numeric(p.ask_price), payout = numeric(p.payout), commission = numeric(p.commission);
    const cd = p.contract_details || {};
    if (!["binary", "accu", "mult"].includes(spec.kind) || spec.request?.currency !== "USD" || !positive(spec.minStake) || !positive(spec.maxStake)) return null;
    if (!positive(ask) || Math.abs(ask - spec.request.amount) > 1e-9 || cents(ask) !== ask) return null;
    if (!positive(ask) || (spec.kind === "binary" && (!positive(payout) || payout <= ask))) return null;
    if (spec.kind === "mult" && (commission == null || commission < 0 || commission >= ask)) return null;
    if (spec.kind === "accu" && (!positive(numeric(cd.tick_size_barrier)) || !Number.isInteger(numeric(cd.maximum_ticks)) || numeric(cd.maximum_ticks) <= 0)) return null;
    return { ...spec, ask, payout: spec.kind === "binary" ? payout : null,
      commission: spec.kind === "mult" ? commission : null,
      barrier: spec.kind === "accu" ? Number(cd.tick_size_barrier) : null,
      maxTicks: spec.kind === "accu" ? Number(cd.maximum_ticks) : null,
      capturedAt, source: "current Deriv public proposal; historical application estimated" };
  }

  function validate(data) {
    if (!data || !Array.isArray(data.prices) || !Array.isArray(data.times) || data.prices.length !== data.times.length || data.prices.length < 500) throw new Error("Need at least 500 timestamped historical ticks");
    if (!Number.isInteger(data.pip) || data.pip < 0 || data.pip > 10) throw new Error("Missing valid price precision");
    const interval = data.symbol.startsWith("1HZ") ? 1 : 2;
    data.prices.forEach((p, i) => {
      if (!positive(p) || !Number.isInteger(data.times[i]) || (i && data.times[i] - data.times[i - 1] !== interval)) throw new Error("Invalid, duplicate or missing historical ticks; no results were invented");
    });
  }

  function indicators(prices) {
    let e9 = prices[0], e21 = prices[0], e20 = prices[0], gain = 0, loss = 0;
    return prices.map((p, i) => {
      if (i) {
        e9 += 2 / 10 * (p - e9); e21 += 2 / 22 * (p - e21); e20 += 2 / 21 * (p - e20);
        const delta = p - prices[i - 1], g = Math.max(0, delta), l = Math.max(0, -delta);
        if (i <= 14) { gain += g / 14; loss += l / 14; }
        else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + l) / 14; }
      }
      return { e9, e21, e20, rsi: i < 14 ? null : loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss) };
    });
  }

  function rankedDigit(digits, end, window, hot) {
    const counts = Array(10).fill(0);
    for (let j = end - window + 1; j <= end; j++) counts[digits[j]]++;
    let best = 0;
    for (let d = 1; d < 10; d++) if (hot ? counts[d] > counts[best] : counts[d] < counts[best]) best = d;
    return best; // deterministic lowest-digit tie break, never looks ahead
  }

  const strategies = [
    { id: "diff-fixed", name: "Differs · fixed 5", family: "differs" },
    { id: "diff-random", name: "Differs · legacy parity-biased epoch reference", family: "differs", random: true },
    ...[25, 50].map(w => ({ id: "diff-cold" + w, name: "Differs · cold " + w, family: "differs", window: w })),
    { id: "match-fixed", name: "Matches · fixed 5", family: "matches" },
    ...[50, 150, 200].map(w => ({ id: "match-hot" + w, name: "Matches · frequent " + w, family: "matches", window: w })),
    { id: "match-agree", name: "Matches · 50/150/200 agreement", family: "matches", agreement: true },
    ...["over", "under"].flatMap(family => [{ id: family, name: family === "over" ? "Over 1 · reference" : "Under 8 · reference", family },
      { id: family + "-filter", name: (family === "over" ? "Over 1" : "Under 8") + " · after two 0/1 digits", family, filter: true }]),
    { id: "rise-fixed", name: "Rise · fixed direction reference", family: "risefall" },
    { id: "rise-ema", name: "Rise/Fall · EMA 9/21", family: "risefall", trend: "ema" },
    { id: "rise-rsi", name: "Rise/Fall · EMA 20 + RSI 14", family: "risefall", trend: "rsi" },
    { id: "touch", name: "Touch · upper barrier, 120 seconds", family: "touch" },
    { id: "notouch", name: "No Touch · upper barrier, 120 seconds", family: "notouch" },
    { id: "accu", name: "Accumulator · original 10% target", family: "accu" },
    { id: "accu-calm", name: "Accumulator · calm filter", family: "accu", filter: true },
    { id: "mult", name: "Multiplier · original 10% target", family: "mult" },
    { id: "mult-trend", name: "Multiplier · EMA, 10% target", family: "mult", trend: "ema" },
    { id: "mult-risk", name: "Multiplier · EMA, 10% stop / 20% target", family: "mult", trend: "ema", stop: .1, target: .2 },
    { id: "diff-evidence", name: "Differs · evidence-gated 200", family: "differs", window: 200, evidence: true, benchmark: "diff-cold50" },
    { id: "matches-evidence", name: "Matches · evidence-gated 200", family: "matches", window: 200, evidence: true, benchmark: "match-hot200" },
    { id: "over-evidence", name: "Over 1 · evidence-gated 200", family: "over", evidence: true, benchmark: "over-filter" },
    { id: "under-evidence", name: "Under 8 · evidence-gated 200", family: "under", evidence: true, benchmark: "under-filter" },
    { id: "rise-revert", name: "Rise/Fall · RSI extreme reversal", family: "risefall", trend: "revert", benchmark: "rise-rsi" },
    { id: "mult-cost", name: "Multiplier · cost filter, 5% stop / 15% target, 60 ticks", family: "mult", trend: "ema", costFilter: true, stop: .05, target: .15, maxTicks: 60, benchmark: "mult-risk" },
    { id: "diff-random-v2", name: "Differs · mixed-bit random reference", family: "differs", random: true, randomV2: true, benchmark: "diff-random" },
  ];

  function signal(s, i, data, ds, ind, options, quotes = {}) {
    let d = 5, direction = options.direction ?? "down";
    if (s.random) d = ((Math.imul(data.times[i], 1664525) + 1013904223) >>> 0) % 10;
    if (s.randomV2) {
      let x = data.times[i] >>> 0;
      x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
      d = Math.floor((x >>> 0) / 4294967296 * 10);
    }
    if (s.window) d = rankedDigit(ds, i, s.window, s.family === "matches");
    if (s.agreement) {
      const choices = [50, 150, 200].map(w => rankedDigit(ds, i, w, true));
      if (new Set(choices).size !== 1) return null;
      d = choices[0];
    }
    if (s.trend === "ema") {
      if (ind[i].e9 === ind[i].e21) return null;
      direction = ind[i].e9 > ind[i].e21 ? "up" : "down";
    }
    if (s.trend === "rsi") {
      if (data.prices[i] > ind[i].e20 && ind[i].rsi > 50 && ind[i].rsi < 70) direction = "up";
      else if (data.prices[i] < ind[i].e20 && ind[i].rsi < 50 && ind[i].rsi > 30) direction = "down";
      else return null;
    }
    if (s.trend === "revert") {
      if (data.prices[i] > ind[i].e20 && ind[i].rsi >= 70) direction = "down";
      else if (data.prices[i] < ind[i].e20 && ind[i].rsi <= 30) direction = "up";
      else return null;
    }
    if (s.filter && ["over", "under"].includes(s.family) && !(ds[i] <= 1 && ds[i - 1] <= 1)) return null;
    const key = ["differs", "matches"].includes(s.family) ? s.family + ":" + d : s.family === "risefall" ? direction === "up" ? "rise" : "fall" : s.family === "mult" ? "mult:" + direction : s.family;
    if (s.evidence) {
      const q = quotes[key];
      if (!q || i < 199) return null;
      let wins = 0;
      for (let j = i - 199; j <= i; j++) if (s.family === "differs" ? ds[j] !== d : s.family === "matches" ? ds[j] === d : s.family === "over" ? ds[j] > 1 : ds[j] < 8) wins++;
      // A past bias must clear pricing plus a margin; this is still only a hypothesis.
      if (lowerWinRate(wins, 200) <= q.ask / q.payout + .01) return null;
    }
    if (s.costFilter) {
      const q = quotes[key];
      if (!q || i < 20) return null;
      const observedMove = Math.abs(data.prices[i] - data.prices[i - 20]) / data.prices[i - 20];
      if (observedMove <= 2 * q.commission / (q.ask * q.request.multiplier)) return null;
    }
    return { key, digit: d, direction };
  }

  function advance(pos, price, last, time) {
    const { s, q, stake } = pos;
    pos.ticks++;
    const ratio = q.payout / q.ask;
    const binary = win => ({ pnl: win ? cents(cents(stake * ratio) - stake - cents(stake * (pos.haircut ?? 0))) : -stake,
      reason: win ? "contract condition met" : "contract condition failed" });
    if (s.family === "differs") return binary(last !== pos.digit);
    if (s.family === "matches") return binary(last === pos.digit);
    if (s.family === "over") return binary(last > 1);
    if (s.family === "under") return binary(last < 8);
    if (s.family === "risefall") return pos.ticks >= q.request.duration ? binary(pos.direction === "up" ? price > pos.entry : price < pos.entry) : null;
    if (["touch", "notouch"].includes(s.family)) {
      const touched = price >= pos.entry + Number(q.request.barrier);
      if (touched) return binary(s.family === "touch");
      if (time - pos.entryTime >= q.request.duration) return binary(s.family === "notouch");
      return null;
    }
    if (s.family === "accu") {
      const move = Math.abs(price - pos.prev) / pos.prev;
      pos.prev = price;
      if (move >= q.barrier) return { pnl: -stake, reason: "barrier breach (estimated)" };
      pos.value *= 1 + q.request.growth_rate;
      const pnl = cents(pos.value - stake);
      return pnl >= Math.max(.1, cents(stake * .1)) || pos.ticks >= q.maxTicks ? { pnl, reason: "growth target / maximum ticks (estimated)" } : null;
    }
    const sign = pos.direction === "up" ? 1 : -1;
    const pnl = Math.max(-stake, cents(stake * q.request.multiplier * sign * (price - pos.entry) / pos.entry - pos.commission));
    pos.value = stake + pnl;
    // Observed tick price, not an invented perfect fill at the stop threshold.
    if (pnl <= -stake || (s.stop && pnl <= -stake * s.stop)) return { pnl, reason: "observed stop; gaps can exceed intended risk" };
    if (pnl >= Math.max(.1, cents(stake * (s.target ?? .1))) || pos.ticks >= (s.maxTicks ?? 120)) return { pnl, reason: "target / time exit (estimated)" };
    return null;
  }

  function simulate(data, quotes, strategy, options = {}, start = 200, end = data.prices.length) {
    validate(data);
    const s = typeof strategy === "string" ? strategies.find(v => v.id === strategy) : strategy;
    if (!s) throw new Error("Unknown research strategy");
    const balance = options.balance ?? 1000, base = options.stake ?? .35, staking = options.staking ?? "flat";
    if (!positive(balance) || !positive(base) || cents(balance) !== balance || cents(base) !== base || !["flat", "paroli2", "paroli3", "martingale3"].includes(staking)) throw new Error("Use positive cent amounts and a supported staking model");
    if ([options.target, options.maxLoss].some(n => n != null && !positive(n))) throw new Error("Session limits must be positive");
    const haircut = options.winningReturnHaircut ?? 0;
    if (typeof haircut !== "number" || !Number.isFinite(haircut) || haircut < 0 || haircut >= 1) throw new Error("Invalid adverse pricing scenario");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 200 || start >= end || end > data.prices.length) throw new Error("Invalid research phase boundaries");
    const ds = data.prices.map(p => digit(p, data.pip)), ind = indicators(data.prices);
    const result = { id: s.id, name: s.name, staking, start, end, trades: 0, wins: 0, losses: 0, breakEven: 0, net: 0,
      maxDD: 0, maxLossStreak: 0, sumWin: 0, sumLoss: 0, totalStakes: 0, history: [], unresolved: 0,
      startingBalance: balance, available: balance, equity: balance, stopped: "end of history", unavailable: 0, signals: 0, boundarySkipped: 0, quoteSources: [] };
    let cash = balance, peak = balance, lossStreak = 0, level = 0, pos = null, queued = null;
    const ratios = [], sources = new Set();
    const mark = () => {
      const equity = cents(cash + (pos ? Math.max(0, pos.value) : 0));
      peak = Math.max(peak, equity); result.maxDD = cents(Math.max(result.maxDD, peak - equity)); result.equity = equity;
    };
    for (let i = start; i < end; i++) {
      if (pos) {
        const settled = advance(pos, data.prices[i], ds[i], data.times[i]);
        if (settled) {
          cash = cents(cash + pos.stake + settled.pnl); result.net = cents(result.net + settled.pnl); result.trades++;
          if (settled.pnl > 0) { result.wins++; result.sumWin = cents(result.sumWin + settled.pnl); lossStreak = 0; }
          else if (settled.pnl < 0) { result.losses++; result.sumLoss = cents(result.sumLoss + settled.pnl); lossStreak++; }
          else { result.breakEven++; lossStreak = 0; }
          result.maxLossStreak = Math.max(result.maxLossStreak, lossStreak);
          result.history.push({ signal: pos.signalTime, entry: pos.entryTime, exit: data.times[i], digit: pos.digit, direction: pos.direction,
            stake: pos.stake, pnl: settled.pnl, reason: settled.reason, quoteKey: pos.q.key, balance: cash, signalIndex: pos.signalIndex });
          if (staking.startsWith("paroli")) level = settled.pnl > 0 ? (level + 1) % Number(staking.slice(-1)) : 0;
          if (staking === "martingale3") level = settled.pnl < 0 ? (level + 1) % 3 : 0;
          pos = null;
        }
        mark();
        continue; // no new entry on a settlement tick
      }
      if ((options.target != null && result.net >= options.target) || (options.maxLoss != null && result.net <= -options.maxLoss)) { result.stopped = "session limit"; break; }
      if (queued) {
        const q = quotes[queued.key], stake = cents(base * 2 ** level);
        queued.stake = stake;
        if (stake < q.minStake || stake > q.maxStake) { result.stopped = "stake outside configured contract limits"; break; }
        if (stake > cash) { result.stopped = "insufficient virtual balance"; break; }
        if (options.maxLoss != null && result.net - stake < -options.maxLoss - 1e-9) { result.stopped = "full-stake loss would breach session limit"; break; }
        cash = cents(cash - stake);
        pos = { ...queued, s, q, haircut, entry: data.prices[i], prev: data.prices[i], entryTime: data.times[i], ticks: 0, value: stake,
          commission: s.family === "mult" ? cents(stake * q.commission / q.ask) : 0 };
        if (s.family === "mult") pos.value = Math.max(0, stake - pos.commission);
        result.totalStakes = cents(result.totalStakes + stake);
        if (q.kind === "binary") ratios.push(cents(stake * q.payout / q.ask) / stake);
        sources.add(q.source); queued = null; mark(); continue;
      }
      const next = signal(s, i, data, ds, ind, options, quotes);
      if (!next) continue;
      result.signals++;
      const q = quotes[next.key];
      if (!q || q.request.underlying_symbol !== data.symbol || q.request.currency !== "USD" || !positive(q.ask)) { result.unavailable++; continue; }
      if (s.family === "accu" && s.filter) {
        let calm = true;
        for (let j = i - 4; j <= i; j++) if (Math.abs(data.prices[j] - data.prices[j - 1]) / data.prices[j - 1] >= q.barrier / 2) calm = false;
        if (!calm) continue;
      }
      if (options.purgeBoundary) {
        const interval = data.symbol.startsWith("1HZ") ? 1 : 2;
        const horizon = s.family === "accu" ? q.maxTicks : s.family === "mult" ? (s.maxTicks ?? 120) :
          q.request.duration_unit === "s" ? Math.ceil(q.request.duration / interval) : q.request.duration;
        if (i + 1 + horizon >= end) { result.boundarySkipped++; continue; }
      }
      queued = { ...next, signalTime: data.times[i], signalIndex: i }; // next tick execution: no same-tick hindsight fill
    }
    result.available = cash;
    if (pos) { result.unresolved = 1; result.openStake = pos.stake;
      result.openPnl = pos.q.kind === "binary" ? null : cents(pos.value - pos.stake);
      result.worstCaseOpenEquity = cash; }
    result.pendingEntryCancelled = Boolean(queued);
    result.averageWin = result.wins ? cents(result.sumWin / result.wins) : null;
    result.averageLoss = result.losses ? cents(-result.sumLoss / result.losses) : null;
    result.winRate = result.trades ? result.wins / result.trades : null;
    result.averageReturn = result.trades ? result.net / result.trades : null;
    const exactWin = result.wins ? result.sumWin / result.wins : null, exactLoss = result.losses ? -result.sumLoss / result.losses : null;
    result.empiricalBreakEven = exactWin && exactLoss ? exactLoss / (exactWin + exactLoss) : null;
    result.rewardRisk = exactWin && exactLoss ? exactWin / exactLoss : null;
    result.profitFactor = result.sumLoss < 0 ? result.sumWin / -result.sumLoss : null;
    result.returnOnStakes = result.totalStakes ? result.net / result.totalStakes : null;
    result.pricingScenario = haircut ? "Adverse sensitivity: reduce each winning return by " + haircut * 100 + "% of stake; not an asserted fee" : "Saved public quote scenario; not historical executable pricing";
    result.quotedBreakEven = ratios.length ? [1 / Math.max(...ratios), 1 / Math.min(...ratios)] : null;
    result.quoteSources = [...sources];
    if (!result.trades && result.boundarySkipped && !result.unavailable) result.stopped = "insufficient phase time for a complete contract";
    result.status = result.unavailable && !result.trades ? "no verified proposal/model data" : result.unresolved ? "incomplete: open contract" : result.stopped;
    return result;
  }

  function returnLowerBound(history, payoutRatio, comparisons = POLICY.minComparisons) {
    if (!history.length || !positive(payoutRatio)) return null;
    if (history.some(h => !positive(h.stake) || !Number.isFinite(h.pnl) || h.pnl / h.stake < -1 - 1e-9 || h.pnl / h.stake > payoutRatio - 1 + 1e-9)) return null;
    const mean = history.reduce((sum, h) => sum + h.pnl / h.stake, 0) / history.length;
    // Binary return support is [-1, payoutRatio-1]. No sample-derived upper bound.
    return Math.max(-1, mean - payoutRatio * Math.sqrt(Math.log(Math.max(POLICY.minComparisons, comparisons) / POLICY.alpha) / (2 * history.length)));
  }

  function assess({ family, training, validation, stressValidation }, options = {}) {
    const reasons = [], balance = options.balance ?? 1000, stake = options.stake ?? .35;
    if (training.trades < POLICY.minTraining) reasons.push("insufficient training trades");
    if (validation.trades < POLICY.minValidation) reasons.push("insufficient validation trades");
    if (training.net <= 0) reasons.push("training net return not positive");
    if (validation.net <= 0) reasons.push("validation net return not positive");
    if (stake > balance * POLICY.maxStakeFraction + 1e-9) reasons.push("full-stake exposure exceeds 2% research risk budget");
    if (options.staking && options.staking !== "flat") reasons.push("progressive staking cannot establish strategy evidence");
    if (validation.maxDD > balance * POLICY.maxDrawdownFraction) reasons.push("validation drawdown exceeds 20%");
    if (training.unresolved || validation.unresolved || training.unavailable || validation.unavailable) reasons.push("incomplete observations or proposal coverage");
    let lowerBound = null;
    if (["accu", "mult"].includes(family)) reasons.push("variable-exit pricing model needs independent validation");
    else {
      lowerBound = returnLowerBound(validation.history, validation.quotedBreakEven ? 1 / validation.quotedBreakEven[0] : null, strategies.length);
      if (lowerBound == null || lowerBound <= 0) reasons.push("multiplicity-adjusted net-return lower bound is not positive");
    }
    const blocks = Array.from({ length: POLICY.blocks }, () => ({ trades: 0, net: 0 }));
    for (const h of validation.history) {
      const index = Math.min(POLICY.blocks - 1, Math.floor((h.signalIndex - validation.start) / (validation.end - validation.start) * POLICY.blocks));
      blocks[index].trades++; blocks[index].net = cents(blocks[index].net + h.pnl);
    }
    if (blocks.some(b => b.trades < POLICY.minBlockTrades || b.net <= 0)) reasons.push("not enough positive evidence in every chronological validation block");
    if (stressValidation.net <= 0 || stressValidation.unresolved || stressValidation.unavailable) reasons.push("adverse-pricing validation failed");
    return { eligible: reasons.length === 0, reasons, lowerBound, blocks };
  }

  function legacySelection(rows, options = {}) {
    const originalIds = new Set(strategies.filter(s => !s.benchmark).map(s => s.id));
    return rows.filter(r => originalIds.has(r.id) && r.validation.trades >= 30 && r.validation.net > 0 && !r.validation.unresolved && r.validation.maxDD <= (options.balance ?? 1000) * .25)
      .sort((a, b) => b.validation.net - a.validation.net || a.validation.maxDD - b.validation.maxDD || a.id.localeCompare(b.id))[0]?.id ?? null;
  }

  function compare(data, quotes, options = {}) {
    validate(data);
    const n = data.prices.length, first = Math.max(201, Math.floor(n * .4)), second = Math.max(first + 1, Math.floor(n * .6));
    const rows = strategies.map(s => ({ id: s.id, name: s.name, family: s.family,
      training: simulate(data, quotes, s, { ...options, purgeBoundary: true }, 200, first),
      validation: simulate(data, quotes, s, { ...options, purgeBoundary: true }, first, second),
      holdout: simulate(data, quotes, s, { ...options, purgeBoundary: true }, second, n),
      stressValidation: simulate(data, quotes, s, { ...options, winningReturnHaircut: POLICY.stressHaircut, purgeBoundary: true }, first, second) }));
    // Test outcomes never enter assess() or ranking. All original models remain benchmarks.
    for (const row of rows) {
      row.assessment = assess(row, options);
      const baselineId = strategies.find(s => s.id === row.id).benchmark;
      const baseline = rows.find(r => r.id === baselineId)?.holdout;
      const h = row.holdout;
      row.classification = !h.trades || h.unresolved ? "INCONCLUSIVE" : h.net <= 0 ? "FAILED IN THIS TEST" :
        baseline && h.trades >= 100 && baseline.trades >= 100 && h.net > baseline.net && h.maxDD <= baseline.maxDD ? "IMPROVED IN THIS TEST" : "INCONCLUSIVE";
      row.benchmark = baselineId ?? null;
    }
    const qualified = rows.filter(r => r.assessment.eligible);
    qualified.sort((a, b) => b.assessment.lowerBound - a.assessment.lowerBound || a.id.localeCompare(b.id));
    const selected = qualified[0]?.id ?? null;
    const stakeReference = selected;
    const staking = selected ? ["flat", "paroli2", "paroli3", "martingale3"].map(model => simulate(data, quotes, stakeReference, { ...options, staking: model, purgeBoundary: true }, second, n)) : [];
    const benchmarkStaking = ["flat", "paroli2", "paroli3", "martingale3"].map(model => simulate(data, quotes, "diff-fixed", { ...options, staking: model, purgeBoundary: true }, second, n));
    return { symbol: data.symbol, observations: n, period: [data.times[0], data.times[n - 1]], first, second, rows, selected,
      beforeSelected: legacySelection(rows, options), policy: POLICY, benchmarkStaking,
      decision: selected ? "RESEARCH CANDIDATE ONLY" : "NO TRADE",
      selectedExposure: selected ? (options.stake ?? .35) : 0,
      selectionNote: selected ? "Qualified on training/validation only; test outcomes are retrospective, not selection inputs. This is a research candidate, not an account trade." : "NO TRADE — no candidate met the research criteria. No fallback strategy or stake is selected. Original benchmarks remain visible above.",
      stakingReference: stakeReference, staking, caveat: CAVEAT };
  }

  const api = { cents, digit, quoteSpecs, quoteRecord, validate, indicators, strategies, signal, advance, simulate, compare, assess, returnLowerBound, legacySelection, lowerWinRate, POLICY, CAVEAT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DerivResearch = api;
})(typeof globalThis === "undefined" ? this : globalThis);
