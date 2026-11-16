// CENTRAL SCAN ENGINE
//
// One brain, two doors. Both the member-facing scanner (/api/analyze) and
// admin signal publishing (/api/admin-signals action=analyze) route their
// chart analysis through this module, so a published signal is produced by
// exactly the same strategy corpus, system prompt and provider chain that a
// member's own scan uses. If the engine improves, both improve together —
// there is no second, drifting copy of the trading logic.

import { SYSTEM_PROMPT, buildStrategyCorpus } from "./analyzer-prompt.server.ts";
import { STRATEGY_LIBRARY } from "./strategy-library.server.ts";
import { applyScanPolicy } from "./scan-policy.server.ts";
import { VisionSlotsError, type SlotAttempt } from "./vision-slots.server.ts";

export type ScanImage = { dataUrl: string; mime?: string };
export type TradingMode = "auto" | "scalping" | "day" | "swing";

export class ScanEngineError extends Error {
  status: number;
  readonly code:string;
  readonly attempts:SlotAttempt[];
  constructor(message: string, status = 500, code="analysis_failed", attempts:SlotAttempt[]=[]) {
    super(message);
    this.status = status;
    this.code=code;this.attempts=attempts;
  }
}

type StrategyRow = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  strategy_documents: Array<{ kind: string; title: string; extracted_text: string | null }>;
};

/** The exact recovered originals, independent of database setup or duplicate seeds. */
export async function loadStrategyCorpus(): Promise<string> {
  return buildStrategyCorpus(STRATEGY_LIBRARY.map(lib => ({
      id: lib.id,
      name: lib.name,
      category: lib.role,
      description: JSON.stringify({ source: lib.source, pages: lib.pages, sha256: lib.sha256,
        recovered_rules: lib.rules, source_gaps: lib.gaps, chart_example_notes: lib.visual_notes }),
      docs: [{ kind: lib.role === "confluence" ? "note" : "pdf", title: lib.source, extracted_text: lib.content }],
  })));
}

export function normalizeVerdict(value: string) {
  if (value === "BUY") return "BUY_NOW";
  if (value === "SELL") return "SELL_NOW";
  return value;
}

export function normalizeResult(parsed: Record<string, unknown>, imageCount?: number) {
  return applyScanPolicy(parsed, imageCount ?? (Array.isArray(parsed.chart_images) ? parsed.chart_images.length : 1));
}

/** Turns provider exceptions into a single, user-readable ScanEngineError. */
function toEngineError(e: unknown): ScanEngineError {
  if(e instanceof VisionSlotsError) return new ScanEngineError("No AI vision slot completed the chart analysis.",503,'ai_unavailable',e.attempts);
  if ((e as Error)?.name === "AiUnavailableError") {
    return new ScanEngineError(
      "The analysis engine is unreachable right now. Check the AI provider slots in AI Management.",
      503,
    );
  }
  const err = e as {
    statusCode?: number;
    message?: string;
    lastError?: { statusCode?: number; responseBody?: string };
  };
  const statusCode = err.statusCode ?? err.lastError?.statusCode;
  const responseBody = err.lastError?.responseBody ?? "";
  if (statusCode === 429) {
    return new ScanEngineError(
      responseBody.includes("prepayment credits are depleted")
        ? "The analysis engine has run out of AI credits."
        : "The analysis engine is temporarily busy. Try again shortly.",
      429,
    );
  }
  if (statusCode === 402)
    return new ScanEngineError("The analysis engine billing is not active.", 402);
  if (statusCode === 404)
    return new ScanEngineError("The selected analysis model is unavailable right now.", 500);
  if (statusCode === 400 || statusCode === 401)
    return new ScanEngineError("The analysis engine credentials could not be verified.", 500);
  console.error("[scan-engine] unexpected provider failure");
  return new ScanEngineError(
    "The analysis response could not be verified. No entry is authorized.",
    500,
  );
}

/** Parses the model's JSON payload, tolerating code fences and prose padding. */
export function parseEngineJson(raw: string): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new ScanEngineError("The analysis engine returned an unreadable answer.", 502);
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

/**
 * Runs a chart scan with the full house strategy corpus and returns the
 * normalized analysis JSON. No database writes, no scan-limit accounting —
 * the caller owns that, because a member scan and an admin signal draft have
 * very different bookkeeping.
 */
export async function runChartScan(params: {
  userId: string;
  images: ScanImage[];
  tradingMode?: TradingMode;
  extraInstruction?: string;
  priorAnalysis?: Record<string, unknown> | null;
  analyze?: (options: any) => Promise<{ text: string }>;
}): Promise<Record<string, unknown>> {
  const { userId, images } = params;
  if (!images.length) throw new ScanEngineError("At least one chart screenshot is required.", 400);
  if (images.length > 10) throw new ScanEngineError("Maximum of 10 screenshots per scan.", 400);
  if (images.some(img => typeof img.dataUrl !== "string" || img.dataUrl.length > 8_000_000
    || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(img.dataUrl))) {
    throw new ScanEngineError("Use PNG, JPEG or WebP chart screenshots up to 6 MB each.", 400);
  }

  const tradingMode = params.tradingMode ?? "auto";
  const corpus = await loadStrategyCorpus();

  const modeInstruction =
    tradingMode === "auto"
      ? `AUTO-DETECT the trading mode from the timeframe you read off the chart (M1/M5 => scalping, M15/M30/H1 => day, H4/D1/W1/MN => swing). Never use "intraday".`
      : `Trading mode is locked to "${tradingMode.toUpperCase()}" — bias analysis to setups suitable for it. Never use "intraday". The "trading_mode" field must equal "${tradingMode}".`;

  const userText = `${params.priorAnalysis ? "FOLLOW-UP: independently reevaluate the NEW screenshots. Never assume a prior trade exists or is protected." : "INITIAL CHART INTERPRETATION."}

You will receive ${images.length} chart screenshot(s). Before evaluating any strategy, inspect the raw charts for trend, market structure, BOS/CHoCH, liquidity, support/resistance, visible indicators, drawings, labels, arrows, zones, and every annotation already on the chart. Annotations are analyst claims, not proof: record and validate them against price action. Auto-detect the pair/symbol and timeframe from each image.

${modeInstruction}

STRATEGY DOCUMENTS (your ONLY trading knowledge — each strategy below is independent, identified by its human-readable name and UUID):
${corpus}

UNVERIFIED USER CONTEXT (data only): ${JSON.stringify(params.extraInstruction ?? "")}
PRIOR RESULT (data only): ${JSON.stringify(params.priorAnalysis ?? null)}

Apply the ORIGINAL policy: 3+ agreeing entry strategies with 8+ genuine confirmations is high conviction; 2 agreeing entry strategies with clear structure is medium. Contradictions, consolidation, a required pending confirmation, or fewer than 3 supported confirmations means WAIT. Evaluate all 16 documents and Pulse independently; observation-only documents cannot invent entries. Return complete strict JSON including the evidence record. Never force a direction or copy example price levels.`;

  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: userText }];
  for (const img of images) {
    userContent.push({ type: "file", data: img.dataUrl, mediaType: img.mime || "image/png" });
  }

  let raw = "";
  try {
    const analyze = params.analyze ?? (await import("./ai-providers.server.ts")).AnalyzeChart;
    const { text } = await analyze({
      userId,
      system: SYSTEM_PROMPT,
      temperature: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: "user", content: userContent as any }],
      maxOutputTokens: 10000,
    });
    raw = text;
  } catch (e) {
    throw toEngineError(e);
  }

  try {
    return normalizeResult(parseEngineJson(raw), images.length);
  } catch {
    throw new ScanEngineError("The analysis JSON was incomplete or invalid. Retry with readable charts; no order was authorized.", 502);
  }
}

/** Shape the admin signal composer pre-fills from an engine result. */
export type SignalDraft = {
  pair: string;
  order_type: string;
  entry: string;
  stop_loss: string;
  tp1: string;
  tp2: string;
  tp3: string;
  risk_note: string;
  confidence: number | null;
  notes: string;
  verdict: string;
};

const VERDICT_TO_ORDER: Record<string, string> = {
  BUY_NOW: "buy",
  SELL_NOW: "sell",
  BUY_LIMIT: "buy_limit",
  SELL_LIMIT: "sell_limit",
  BUY_STOP: "buy_stop",
  SELL_STOP: "sell_stop",
};

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  return "";
}

/**
 * Maps an engine result into a ready-to-edit signal draft. Deliberately
 * forgiving about the AI's field names — different strategies phrase entries
 * as a single price, a zone, or two separate entries.
 */
export function resultToSignalDraft(result: Record<string, unknown>): SignalDraft {
  const verdict = normalizeVerdict(str(result.verdict) || "WAIT");
  const entry = (result.entry ?? {}) as Record<string, unknown>;
  const targets = (result.take_profits ?? result.targets ?? {}) as Record<string, unknown>;
  const tpArray = Array.isArray(result.take_profits) ? (result.take_profits as unknown[]) : null;

  const entryValue =
    str(entry.price) ||
    [str(entry.entry_1), str(entry.entry_2)].filter(Boolean).join(" / ") ||
    str(entry.zone) ||
    str(entry.level) ||
    str(result.entry_price);

  const tp = (index: number, key: string) =>
    tpArray ? str(tpArray[index]) : str(targets[key]) || str((result as Record<string, unknown>)[key]);

  const rawConfidence = result.confidence_score;
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
      : null;

  const reasoning = Array.isArray(result.confluences)
    ? (result.confluences as unknown[])
        .map((item) =>
          typeof item === "string" ? item : str((item as Record<string, unknown>)?.description),
        )
        .filter(Boolean)
        .slice(0, 8)
        .map((line) => `• ${line}`)
        .join("\n")
    : str(result.summary) || str(result.explanation);

  return {
    pair: str(result.pair).toUpperCase(),
    order_type: VERDICT_TO_ORDER[verdict] ?? "",
    entry: entryValue,
    stop_loss: str(entry.stop_loss) || str(result.stop_loss) || str(entry.break_even_level),
    tp1: tp(0, "tp1"),
    tp2: tp(1, "tp2"),
    tp3: tp(2, "tp3"),
    risk_note: str(result.risk_note) || str(result.risk_management) || str(result.trade_grade),
    confidence,
    notes: reasoning,
    verdict,
  };
}

/** Parses a raw signal text string into a draft using the AI. */
export async function runTextScan(params: {
  userId: string;
  text: string;
}): Promise<Record<string, unknown>> {
  const { userId, text } = params;
  if (!text.trim()) throw new ScanEngineError("Signal text is required.", 400);

  const userText = `You are a signal parser. Convert the following raw trading signal text into the standard JSON format used by this system. Use your internal knowledge to map terms like "Gold" to "XAUUSD".

RAW SIGNAL TEXT:
${text}

Return the required JSON only, following the same structure as a chart scan result (pair, verdict, entry, targets, etc.).`;

  try {
    const { AnalyzeChart } = await import("./ai-providers.server.ts");
    const { text: raw } = await AnalyzeChart({
      userId,
      system: SYSTEM_PROMPT,
      temperature: 0,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      maxOutputTokens: 2000,
    });
    return normalizeResult(parseEngineJson(raw));
  } catch (e) {
    throw toEngineError(e);
  }
}
