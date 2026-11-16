# Separate, credit-free M1 virtual research

This is an experimental research preset, **not a modification of the original PDF strategies or the existing Demo bot**. Nothing here is imported by the broker worker, and no account balance, credential, authorization, purchase or sale is requested. There is no replacement virtual wallet or dashboard redesign.

## Exact definitions frozen before evaluation

Both presets require EMA20/EMA50 agreement on closed M1 and closed M5 candles, at least 360 consecutive M1 warmup bars, and a nonzero 14-bar true-range mean. Indicators use past observations only. Timeframe aggregation includes only five complete chronological minutes; an incomplete M5 candle cannot vote.

- **M1 pullback/reclaim:** in an upward trend, the previous M1 candle tests EMA20 and closes at/below it; the current closed candle reclaims EMA20 with a bullish body and a higher high. Buy interpretation. Stop below the lower low of those two candles, by one provider price increment. Mirror all conditions for sells.
- **M1 breakout:** a bullish body closes above the preceding 20 closed M1 highs in an upward trend. Stop below the last three candles' lows, by one increment. Mirror for sells.

These are new explicit experimental rules. They do not pretend to recover a missing M1 version of Giant Killer. Both original documents and the current executable M15/H1 subset remain unchanged for comparison.

A signal is evaluated only after the M1 close. Its hypothetical entry uses the next actual candle open plus one adverse provider increment. Price target is 1.5 times that price risk. Stop and target are distinct from net reward/risk after commission. An open position is closed after five observed M1 candles if neither level was reached. If both levels touched inside the same OHLC candle, the stop wins conservatively and the result is flagged ambiguous. Adverse gaps use their open, favourable gaps receive no extra target profit. Unknown intervals or a position open at a period boundary remain unresolved, with no invented settlement.

Only one virtual position may exist across the five selected markets. Simultaneous signals are ranked by closed M1 EMA separation divided by ATR, then symbol; the stake stays at $1 after wins and losses. There is no simulated account wallet, Martingale or escalation. This is a research normalization, not money in the connected account.

The current public provider quote supplies the lowest common listed multiplier, $1 commission, price precision and supported stop/target amount limits for each direction. Unsupported exits are rejected. These are **current quote scenarios applied to historical candles**, not recovered historical/authenticated contract prices. Commission is deducted on every hypothetical trade, and losses are capped at the stake. The adverse sensitivity reprices identical trades/paths with twice that commission and another adverse increment on both fills, so cost stress cannot improve results by omitting losing trades.

Results include wins/losses/break-even, net P/L, mean reward/risk, break-even rates, losing streak, settled drawdown and a separate conservative OHLC equity drawdown bound including open positions. OHLC cannot establish exact intrabar drawdown or execution order. The empirical break-even win rate is unavailable when the sample lacks either wins or losses; it is not silently replaced with 0%.

## Protocol and reproduction

The fixed market list, October 19–November 9 UTC periods, risk rules, candidate count and qualification rules are in [protocol.json](protocol.json). The first seven days train; the next seven validate and select; the final seven are read only after selection. Test outcomes cannot choose a different strategy. The periods precede the earlier inspected November 12–16 research samples.

Qualification requires enough trades and days, positive training/validation/cost stress, positive results in each chronological validation block, acceptable drawdown, no unresolved positions and a positive candidate-adjusted daily-block bootstrap bound. That bound is descriptive sensitivity from a small dependent historical sample, not a probability of future profit. No qualifying candidate means **NO TRADE**, with no fallback into account execution.

With the existing backend Python environment (no new packages):

```sh
python scripts/capture-m1-research.py
node scripts/evaluate-m1-research.mjs
node --test tests/m1-research.test.mjs
```

The capture requires a committed, unchanged protocol/engine/tools before it downloads data. It checks requested dates, pages below the provider's 1,000-bar cap, preserves genuine market gaps and rejects wrong-date substitutions. Capture resumes completed markets without redownloading them. Frozen hashes, quote scenarios and compressed public candle snapshots are recorded for reproduction. No API keys are needed.

Implementation tests use synthetic fixtures solely to verify code, including adverse cases and a deliberately strong positive control. They are never counted as market-performance evidence. Historical results and remaining limitations will be recorded after the frozen evaluation; no forward-profit or authenticated-execution claim is made.
