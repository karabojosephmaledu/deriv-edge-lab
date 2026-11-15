// Deterministic enforcement of the recovered scanner's heuristic policy.
// This validates the evidence record's structure, not the truth of AI vision.
// Its output is chart interpretation, never authorization to send broker orders.
import { STRATEGY_LIBRARY } from "./strategy-library.server.ts";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const sourceById = new Map(STRATEGY_LIBRARY.map(s => [s.id, s]));
const directions = new Set(["BUY_NOW", "SELL_NOW", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"]);
const confirmationKinds = new Set([
  "structure", "body_close_bos", "choch", "liquidity_sweep", "order_block",
  "supply_demand", "retest", "engulfing", "rejection", "inside_bar", "fvg",
  "trendline", "ema", "sma", "fibonacci", "session", "pattern", "volume",
]);

function validPage(id: unknown, page: unknown): boolean {
  const doc = sourceById.get(string(id));
  return Boolean(doc && Number.isInteger(page) && Number(page) >= 1 && Number(page) <= doc.pages);
}

export function confidenceScore(n: number, aligned: boolean, agreeing: number, conflicts: boolean, verdict: string): number {
  const confirmations = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const score = 30 + 5 * Math.min(10, confirmations) + (aligned ? 10 : 0)
    + (agreeing >= 3 ? 10 : 0) - (conflicts ? 15 : 0)
    - (verdict === "WAIT" || verdict === "NO_TRADE" ? 20 : 0)
    - (["INVALID_SETUP", "NO_STRATEGY_MATCH"].includes(verdict) ? 30 : 0);
  return Math.round(Math.max(0, Math.min(100, score)) / 5) * 5;
}

export function applyScanPolicy(input: Row, imageCount = 10): Row {
  const result: Row = structuredClone(input);
  const reasons: string[] = [];
  const warnings = list(result.warnings).filter(v => typeof v === "string") as string[];
  const metadata = list(result.chart_images).map(row);
  const charts = new Map<number, Row>();
  for (const img of metadata) {
    if (Number.isInteger(img.image_index) && Number(img.image_index) >= 1 && Number(img.image_index) <= imageCount
      && img.readable === true && string(img.symbol) && string(img.timeframe)) {
      charts.set(Number(img.image_index), img);
    }
  }
  const chartReadable = result.chart_readable === true && charts.size === imageCount;
  const symbols = new Set([...charts.values()].map(c => string(c.symbol).toUpperCase()));
  if (symbols.size > 1) reasons.push("The uploaded charts show different instruments; their directional votes cannot be combined.");

  const seenEvents = new Set<string>();
  const evidence = list(result.evidence).map(row).filter(e => {
    const chart = charts.get(Number(e.image_index));
    const event = string(e.chart_event_id);
    const id = string(e.id);
    const valid = Boolean(chart && id && event && e.status === "confirmed"
      && string(e.observation) && string(e.timeframe) === string(chart.timeframe)
      && confirmationKinds.has(string(e.kind))
      && list(e.sources).some(s => validPage(row(s).strategy_id, row(s).page))
      && (e.kind !== "body_close_bos" || (e.candle_closed === true && e.body_close_confirmed === true)));
    // The same chart event cannot become several confirmations through synonyms.
    if (!valid || seenEvents.has(event)) return false;
    seenEvents.add(event);
    return true;
  });
  const evidenceIds = new Set(evidence.map(e => string(e.id)));
  if (evidenceIds.size !== evidence.length) reasons.push("Confirmation identifiers are duplicated.");
  const evaluations = list(result.strategy_evaluations).map(row);
  const evaluationMap = new Map<string, Row>();
  for (const e of evaluations) {
    const id = string(e.strategy_id);
    if (!sourceById.has(id)) { reasons.push("An evaluation cites an unrecognized strategy."); continue; }
    if (evaluationMap.has(id)) { reasons.push("A strategy was evaluated more than once."); continue; }
    evaluationMap.set(id, e);
  }
  if (evaluationMap.size !== STRATEGY_LIBRARY.length) reasons.push("Not every recovered strategy was independently evaluated.");

  const matched = [...evaluationMap.values()].filter(e => e.status === "match"
    && ["BUY", "SELL"].includes(string(e.direction))
    && list(e.missing_conditions).length === 0
    && list(e.source_pages).length > 0 && list(e.source_pages).every(p => validPage(e.strategy_id, p))
    && list(e.evidence_ids).some(id => evidenceIds.has(string(id))));
  // Observation material and Pulse are evaluated, but cannot authorize entries alone.
  const entryVotes = matched.filter(e => sourceById.get(string(e.strategy_id))?.role === "entry");
  const sides = new Set(entryVotes.map(e => string(e.direction)));
  const conflicts = sides.size > 1 || [...evaluationMap.values()].some(e => e.status === "contradicts");
  if (conflicts) reasons.push("The strategies contradict one another.");
  const direction = sides.size === 1 ? [...sides][0] : "";
  const alignedCharts = [...charts.values()].filter(c => c.bias === direction);
  const aligned = symbols.size === 1 && alignedCharts.length >= 2
    && new Set(alignedCharts.map(c => string(c.timeframe))).size >= 2;
  const strong = entryVotes.length >= 3 && evidence.length >= 8;
  const medium = entryVotes.length >= 2 && result.structure_clear === true && evidence.length >= 3;

  let verdict = string(result.verdict).toUpperCase();
  if (verdict === "BUY") verdict = "BUY_NOW";
  if (verdict === "SELL") verdict = "SELL_NOW";
  if (!chartReadable) verdict = "INVALID_SETUP";
  else if (matched.length === 0 && evaluationMap.size === STRATEGY_LIBRARY.length
    && [...evaluationMap.values()].every(e => ["not_applicable", "unverifiable"].includes(string(e.status)))) {
    verdict = "NO_STRATEGY_MATCH";
  } else {
    if (evidence.length < 3) reasons.push("Fewer than three supported chart confirmations are present.");
    if (result.consolidating !== false || result.awaiting_confirmation !== false) reasons.push("Price is consolidating, awaiting confirmation, or its readiness is unverified.");
    if (!(strong || medium)) reasons.push("The original strategy-agreement threshold is not met.");
    if (result.structure_clear !== true) reasons.push("The current market structure is not clearly verified.");
    if (result.needs_more_timeframes === true) reasons.push("A strategy's required timeframe is missing.");
    if (reasons.length || !directions.has(verdict) || !verdict.startsWith(direction)) verdict = "WAIT";
  }
  const score = confidenceScore(evidence.length, aligned, entryVotes.length, conflicts, verdict);
  const pattern = row(result.pattern_validation);
  const rr = typeof result.risk_reward === "number" && Number.isFinite(result.risk_reward) ? result.risk_reward : 0;
  let grade = "D";
  if (directions.has(verdict)) {
    if (evidence.length >= 12 && aligned && pattern.valid === true && pattern.complete === true
      && entryVotes.length >= 3 && result.clean_structure === true && rr >= 3) grade = "A_PLUS";
    else if (evidence.length >= 9 && entryVotes.length >= 3) grade = "A";
    else if (evidence.length >= 6) grade = "B";
    else if (evidence.length >= 4) grade = "C";
  }
  result.verdict = verdict;
  result.confidence_score = score;
  result.confidence = score <= 30 ? "very_low" : score <= 50 ? "low" : score <= 70 ? "medium" : score <= 85 ? "high" : "very_high";
  result.trade_grade = grade;
  result.confirmations_found = evidence.map(e => string(e.observation));
  const matchedIds = matched.map(e => string(e.strategy_id));
  result.matched_strategy_ids = matchedIds;
  result.matched_strategy_id = matchedIds[0] ?? null;
  result.matched_strategy_name = sourceById.get(string(result.matched_strategy_id))?.name ?? null;
  if (!directions.has(verdict)) {
    result.entry = null;
    result.break_even_area = null;
    result.invalidation_area = null;
    result.target_area = null;
    result.wait_explanation = { what_is_missing: reasons.join(" ") || "No supported entry is available.", where: "Current uploaded charts", which_timeframe: string(result.detected_timeframe) || "Unknown" };
  } else if (result.entry && typeof result.entry === "object") {
    (result.entry as Row).direction = direction;
  }
  warnings.push("Confidence is an original heuristic software score, not a probability of profit.");
  warnings.push("Chart observations are AI interpretations; source citations and schema checks do not independently verify market events.");
  result.warnings = [...new Set(warnings)];
  result.policy_audit = { version: "original-evidence-v1", confirmations: evidence.length, agreeing_entry_strategies: entryVotes.length,
    conflicts, timeframes_aligned: aligned, conviction: directions.has(verdict) ? strong ? "high" : "medium" : "none", reasons };
  result.broker_execution_authorized = false;
  return result;
}
