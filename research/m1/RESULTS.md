# Frozen M1 research result: NO TRADE

Both new presets generated entries but **failed** the predeclared criteria. Neither is connected to Demo or Live execution. The existing dashboard, account login/balances/history, sounds, broker worker, original source corpus and M15/H1 strategies remain byte-for-byte unchanged. This PR introduces research files and tests only; it does not merge PR #18's separate diagnostics fix.

## What was evaluated

- Genuine, previously uninspected public Deriv history: **142,670 M1 candles**, including warmup, across R_100, R_25, 1HZ75V, Gold/USD and BTC/USD. Gaps were retained, never filled with invented bars.
- Training: October 19–25, 2026 UTC. Validation/selection: October 26–November 1. Held-out test: November 2–8. Each period is seven days; end boundaries are exclusive.
- Fixed hypothetical **$1 per position**, one portfolio position across the five markets. No $1,000 wallet, compounding or stake escalation.
- The engine, protocol and tools were committed locally at `164d2d9` before downloading the historical observations. Their SHA-256 hashes are embedded in every compressed input snapshot and checked by the evaluator. Rules were not tuned after viewing results. These dates are now inspected data and must not be called unseen again in future experiments.
- Current public commission snapshots: $0.02 per $1 for R_100 (×40), R_25 (×160), 1HZ75V (×50) and Gold (×100); $0.08 for BTC (×100), for both directions. Current public stop/target limits also filter feasibility. They are not historical or authenticated contract prices.

## Results

| Preset | Training net | Validation net | Held-out net | Held-out trades | Decisive win rate | Observed reward/risk | Empirical break-even | Settled drawdown | Conservative equity DD bound | Longest losing streak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M1 pullback/reclaim | −$14.55 | −$10.95 | **−$11.11** | 529 | 40.5% | 0.96 | 50.9% | $11.40 | $11.48 | 10 |
| M1 breakout | −$21.11 | −$22.99 | **−$21.36** | 827 | 41.8% | 0.80 | 55.5% | $21.84 | $21.91 | 11 |

“Decisive win rate” excludes zero-profit settlements so it can be compared with the empirical break-even calculation. The raw JSON also reports wins divided by **all** settlements: 39.3% and 40.3%, respectively. There were 16 and 30 break-even settlements. Break-even is `average loss / (average win + average loss)`, using unrounded observed means; it describes this sample, not a guaranteed future threshold.

At the same fixed stake, doubling snapshot commissions and adding another adverse increment to both fills worsened held-out net to **−$24.36** and **−$43.42**. Stress retained the same entries and exits; it did not discard expensive losses. No unresolved or ambiguous settlements occurred in these particular portfolios, although the engine and tests cover both outcomes.

Both strategies lost in all three chronological validation blocks and had negative daily-block bootstrap lower bounds. Neither met the drawdown requirement. No candidate was selected on validation; held-out results did not cause a switch to another strategy. All five markets contributed negative held-out net for both presets, so no symbol was cherry-picked from the test.

## Why more trades did not solve the problem

The M1 presets remove the prior-day/M15/H1 timing requirement, so they generate hundreds of hypothetical entries rather than waiting for that original pattern. They still do not meet a promise of one trade per minute: held-out median entry gaps were **13 minutes** for pullback and **9 minutes** for breakout, with longer gaps during missing-data warmup and absent setups. The original M15/H1 audit used a different dataset; its zero entries are not an apples-to-apples P/L baseline for this study.

Costs and exits matter. Although the price target was 1.5 times initial price risk, the five-minute time exit closed 293/529 pullback positions and 624/827 breakout positions before a barrier. Actual average net win versus loss was therefore about **$0.102/$0.106** and **$0.087/$0.108**, not a guaranteed 1.5-to-1 payoff. Current snapshot commission totalled $12.98 and $21.58 over the held-out trades; those costs consumed the already-small gross scenario returns. Removing commission to display a profit would misrepresent the assumptions.

These are failed historical **pricing scenarios**, not proof that the PDFs are wrong, that every possible M1 strategy loses, or that these were executable historical Deriv contracts. OHLC cannot verify bid/ask spread, within-candle order, actual fills, financing or account eligibility. The equity drawdown figure is a conservative bound, not exact tick reconstruction. The bootstrap is descriptive day-block sensitivity on a short sample, not proof of independent returns or a probability of profit. No prospective or three-month forward test is claimed.

## Deliverables and remaining work

The two explicit presets, causal M1/M5 features, automatic virtual symbol ranking, fixed-stake portfolio replay, provider-scenario validation, adverse fills, loss cap, cost stress, selection/NO TRADE gate and reproducible compressed public snapshots are complete. [results.json](results.json) contains all metrics and [data/manifest.json](data/manifest.json) contains the input/quote provenance.

Reproduce with `node scripts/evaluate-m1-research.mjs`. The full ledger is generated locally as `research/m1/data/results-full.json`; it is not another website history panel. Reproduction reuses now-inspected data and is a software check, not fresh evidence. No AI key, account token, database, paid service or dependency installation is needed.

**326 relevant automated tests passed:** 156 scanner/research/simulation Node tests, 163 account/Demo/automatic-session/capture Python tests, and seven fixed-data reproduction tests. The updated isolation assertion was also rerun with all 20 M1 unit tests passing. Existing frontend/account/order files have no diff from the production baseline, so unchanged browser suites were not repeated. Python syntax checks, frozen-input hash verification and whitespace checks also passed. No authenticated Demo or Live orders were used for testing.

**Not ready for Demo or Live activation.** Research has not established a profitable or once-per-minute strategy. Any subsequent changed rules need another frozen protocol and genuinely unused evaluation data. The outcome remains **NO TRADE**; existing account execution settings are unchanged.
