# Virtual research rebuild v2 — final review

This is a virtual-only research update stacked on revised PR #5. It changes no Demo account configuration, manual digit selection, order route, settlement or security code. Nothing has been merged or deployed.

## What was completed

- Preserved all 23 original references, including flawed ones as explicitly labelled benchmarks; added seven virtual-only alternatives.
- Fixed a parity-biased random-digit reference. On regular two-second epochs the old arithmetic can reach at most five digits (only two in the unit-test window). The corrected mixed-bit reference covers all ten. The old version remains visible and labelled, so its past results are not erased.
- Fixed empirical break-even calculations that rounded mean wins/losses before forming the ratio. For example, mean wins of $0.015 must not first become $0.02. Settlement rounding to cents remains unchanged.
- Hardened payout validation: reject booleans/blank/array/non-finite monetary values, quotes for a different stake, and invalid commission/model fields. Numeric strings actually used by providers remain supported. Missing quotes never get a fabricated payout.
- Added evidence-gated Differs, Matches, Over 1 and Under 8, RSI-extreme reversal, a cost-filtered/time-limited Multiplier study, and a corrected random reference. All remain virtual.
- Rebuilt selection to return NO TRADE unless a candidate clears the predeclared research criteria. No fixed-strategy fallback or projected stake is inserted. Original staking illustrations are clearly unselected benchmarks in a separate expandable table.
- Added per-window FAILED IN THIS TEST, IMPROVED IN THIS TEST and INCONCLUSIVE labels. These are retrospective observations and never choose a candidate.

## Separation and release status

- [PR #5](https://github.com/karabojosephmaledu/deriv-edge-lab/pull/5): safe website/account/payout improvements and virtual research foundation. Manual Demo controls remain; experimental policy fields are rejected. Its split passed 144 checks.
- [Draft PR #6](https://github.com/karabojosephmaledu/deriv-edge-lab/pull/6): unapplied archive of the removed execution proposal. Adds no runtime functionality; not ready for merge or deployment.
- This research rebuild: separate PR on `feature/research-rebuild-v2`, based on PR #5. It can be reviewed for software correctness; no strategy is approved or connected to account execution.

## Frozen method and genuinely separate data

The protocol and implementation were committed as **75fa03e027719195aa460275a280444de1785894 before collecting or inspecting the new data**. Capture metadata records the commit and SHA-256 of the engine and protocol. The evaluator rejects mismatched hashes. No strategy settings were tuned after reading the new test results.

The earlier 6,000 ticks were already inspected and remain **development data**, not newly unseen data. The new snapshot contains **20,000 public Deriv ticks**: R_100 and R_25, each with 5,000 consecutive ticks starting at noon UTC on 12 and 14 November 2026. Each window ends at 14:46:40 UTC. They do not overlap the earlier development windows. Timestamp, gap, precision and count checks reject incorrect pages rather than substituting current data.

This is previously uninspected historical evaluation, **not a prospective three-month forward test**. Within each new 5,000-tick window: 40% training (200 warm-up ticks), 20% validation, 40% untouched test. Entries occur after the signal tick, and duration buffers prevent a position crossing the phase boundary. Only training and validation affect selection. Test outcomes provide the final retrospective assessment.

Prices are historical public ticks. Payouts and commissions use the saved public proposal scenarios from the earlier collection. They are **not historical executable quotes or the user's authenticated Demo pricing**. Payouts were not increased. A separate adverse sensitivity check subtracts 2.5% of stake from each winning binary return; this is a stress assumption, not an asserted Deriv fee. The model's entry/exit/fill limitations remain.

## Stricter criteria and NO TRADE

Each selected research candidate must have at least 100 completed training and 100 validation trades, positive training and validation net results, no more than 2% full-stake exposure, no more than 20% validation drawdown, complete quote/observation coverage, and positive evidence with at least 20 trades in every one of four chronological validation blocks. Progressive staking cannot establish eligibility.

For fixed-payoff binary returns, a Hoeffding-style lower bound on mean profit per stake must be positive after allowing for at least 32 comparisons at alpha 0.05. The bound uses the quoted payoff support, not a conveniently small observed return range. Independent bounded outcomes are an assumption, not a demonstrated market property. This is a conservative research screen, not a guarantee of a persistent edge or real-world profitability. Accumulator/Multiplier variable-exit models remain available as benchmarks but cannot qualify until their historical valuation is independently validated.

If nothing qualifies, the selected result is **NO TRADE: null strategy, zero selected stake/exposure, no staking projection**. Benchmark results can still show wins and losses. A positive single-period benchmark does not override the screen. This result cannot start, stop or modify the separate existing Demo bot.

## Before and after

The new evaluation uses four independent virtual wallets, each starting at $1,000 with $10 flat stakes. These are scenario totals across separate runs, not one continuous account curve.

| Dataset | Old selection net P/L | Rebuilt selection net P/L | New decision |
|---|---:|---:|---|
| Earlier development, six $1,000/$50 cases | $-626.82 | $0.00 | NO TRADE in all six |
| New evaluation, four $1,000/$10 cases | $-226.39 | $0.00 | NO TRADE in all four |

The $0 result is abstention, not a newly profitable strategy. The strict screen skipped three losing old recommendations and also skipped one profitable old recommendation. That trade-off is reported instead of hiding missed opportunities.

| Market/date | Old selected reference | Old test P/L | Old test drawdown | New decision |
|---|---|---:|---:|---|
| R_100 / 2026-11-12 | diff-cold25 | $-127.84 | $146.08 | NO TRADE |
| R_100 / 2026-11-14 | over | $-142.72 | $279.20 | NO TRADE |
| R_25 / 2026-11-12 | rise-ema | $+138.09 | $128.33 | NO TRADE |
| R_25 / 2026-11-14 | rise-rsi | $-93.92 | $259.87 | NO TRADE |

## All supported studies on the new test data

Trades and P/L sum the four independent test windows. Drawdown and longest loss streak are the worst single window. Reward/risk and break-even show the range of observed per-window values, not a promise about the next trade. A high-drawdown figure can exceed initial capital after a large prior gain. NO TRADE models with zero entries are inconclusive, not profitable. Touch lacked a supported quote in both R_25 windows, so its apparent best total uses only the two R_100 windows.

| Study | Trades | Win rate | Estimated net P/L | Worst window DD | Longest losses | Reward/risk range | Break-even win range | Positive / traded windows | Aggregate finding |
|---|---:|---:|---:|---:|---:|---|---|---|---|
| diff-fixed | 2664 | 90.32% | $-270.24 | $184.56 | 3 | 0.096 | 91.24% | 0/4 | FAILED aggregate |
| diff-random | 2664 | 90.69% | $-160.64 | $229.84 | 3 | 0.096 | 91.24% | 2/4 | FAILED aggregate |
| diff-cold25 | 2664 | 90.05% | $-346.96 | $152.40 | 2 | 0.096 | 91.24% | 0/4 | FAILED aggregate |
| diff-cold50 | 2664 | 90.43% | $-237.36 | $153.36 | 2 | 0.096 | 91.24% | 0/4 | FAILED aggregate |
| match-fixed | 2197 | 9.47% | $-3,397.68 | $1291.30 | 61 | 7.929 | 11.20% | 0/4 | FAILED aggregate |
| match-hot50 | 1950 | 9.79% | $-2,445.61 | $1107.75 | 59 | 7.929 | 11.20% | 0/4 | FAILED aggregate |
| match-hot150 | 2352 | 9.82% | $-2,894.01 | $1187.04 | 47 | 7.929 | 11.20% | 0/4 | FAILED aggregate |
| match-hot200 | 2343 | 9.52% | $-3,518.33 | $1505.62 | 44 | 7.929 | 11.20% | 0/4 | FAILED aggregate |
| match-agree | 595 | 8.40% | $-1,485.50 | $775.68 | 51 | 7.929 | 11.20% | 1/4 | FAILED aggregate |
| over | 2664 | 79.88% | $-423.04 | $279.20 | 6 | 0.232 | 81.17% | 0/4 | FAILED aggregate |
| over-filter | 248 | 76.61% | $-139.20 | $64.16 | 3 | 0.232 | 81.17% | 0/4 | FAILED aggregate |
| under | 2664 | 79.13% | $-669.44 | $366.96 | 5 | 0.232 | 81.17% | 0/4 | FAILED aggregate |
| under-filter | 248 | 76.61% | $-139.20 | $94.16 | 4 | 0.232 | 81.17% | 1/4 | FAILED aggregate |
| rise-fixed | 1140 | 50.79% | $-92.13 | $252.90 | 9 | 0.953 | 51.20% | 1/4 | FAILED aggregate |
| rise-ema | 1140 | 49.21% | $-442.27 | $298.38 | 8 | 0.953–0.954 | 51.18%–51.20% | 1/4 | FAILED aggregate |
| rise-rsi | 1080 | 48.98% | $-467.19 | $269.48 | 11 | 0.953–0.954 | 51.18%–51.20% | 1/4 | FAILED aggregate |
| touch | 95 | 57.89% | $+23.50 | $111.50 | 6 | 0.770 | 56.50% | 1/2 | INCONCLUSIVE — limited/inconsistent evidence |
| notouch | 159 | 64.15% | $-85.38 | $128.52 | 9 | 0.021–1.179 | 45.89%–97.94% | 2/4 | FAILED aggregate |
| accu | 1316 | 87.92% | $-132.18 | $114.60 | 3 | 0.126 | 88.81% | 0/4 | FAILED aggregate |
| accu-calm | 479 | 86.22% | $-139.62 | $140.60 | 3 | 0.126 | 88.81% | 1/4 | FAILED aggregate |
| mult | 107 | 62.62% | $-42.94 | $26.21 | 4 | 0.330–0.535 | 65.14%–75.18% | 1/4 | FAILED aggregate |
| mult-trend | 105 | 61.90% | $-36.93 | $22.07 | 3 | 0.360–0.457 | 68.64%–73.54% | 1/4 | FAILED aggregate |
| mult-risk | 219 | 26.48% | $-64.53 | $30.99 | 12 | 1.528–1.962 | 33.76%–39.55% | 0/4 | FAILED aggregate |
| diff-evidence | 0 | — | $0.00 | $0.00 | 0 | — | — | 0/0 | INCONCLUSIVE — no eligible entries |
| matches-evidence | 0 | — | $0.00 | $0.00 | 0 | — | — | 0/0 | INCONCLUSIVE — no eligible entries |
| over-evidence | 0 | — | $0.00 | $0.00 | 0 | — | — | 0/0 | INCONCLUSIVE — no eligible entries |
| under-evidence | 0 | — | $0.00 | $0.00 | 0 | — | — | 0/0 | INCONCLUSIVE — no eligible entries |
| rise-revert | 209 | 46.41% | $-195.33 | $179.40 | 6 | 0.953–0.954 | 51.18%–51.20% | 1/4 | FAILED aggregate |
| mult-cost | 563 | 13.85% | $-191.67 | $57.51 | 38 | 2.379–2.521 | 28.40%–29.60% | 0/4 | FAILED aggregate |
| diff-random-v2 | 2664 | 90.47% | $-226.40 | $208.16 | 3 | 0.096 | 91.24% | 2/4 | FAILED aggregate |

**Best raw result:** Touch, +$23.50 over 95 completed trades, with one profitable and one losing tradable window. The other two windows had no supported quote. Its sample size, inconsistency and pricing limitations prevent qualification. No model passed the stricter criteria.

**What improved:** quote validation, arithmetic precision, the coverage of the random reference, time-separated evaluation and the ability to abstain. The corrected random reference improved versus the old reference in one test window, but lost $226.40 in aggregate. That is not a persistent trading improvement. The new RSI-reversal variant lost less money in total than the RSI trend reference because it traded much less; this must not be presented as evidence of higher return per risk. The new Multiplier cost filter lost $191.67 and failed in all four windows. The four evidence-gated digit studies found no qualifying local signals and remain inconclusive. No winning result was fabricated to make an experiment look successful.

## Tests, security and reproduction

All **166 automated checks passed**: 118 Node checks (including mocked desktop/mobile browser flows, research regressions and four new evaluation-integrity checks) and 48 Python checks. Original Demo configuration and manual digit selection are preserved; the virtual rebuild's account/order source files match the safe foundation byte-for-byte. No secrets, new dependency or paid service was added. No account orders were placed by these tools. No merge or deployment occurred.

```bash
node --test --test-concurrency=1 tests/simulation.test.cjs tests/simulation-browser.test.cjs tests/demo-browser.test.cjs tests/deployment.test.cjs tests/research.test.cjs tests/research-v2.test.cjs tests/evaluation-v2.test.cjs
node scripts/evaluate-v2.cjs
cd backend
python -m pytest tests/test_demo_execution.py
```

The existing endpoint tests require the local backend fixture described in backend/tests/conftest.py; this review ran them against the controlled local server. The evaluator reads the versioned snapshots and writes ignored research/results-v2.json. The compressed evaluation input is research/unseen-v2.json.gz. No network or credentials are required to reproduce evaluation. Refreshing it would change the experiment and must not silently overwrite this fixed result.

Still unproven: profitable forward performance, historical executable pricing, validated Accumulator/Multiplier historical fill models, and three months of prospective observation. These are research limitations, not unfinished website changes. Live acceptance of new UI/account displays remains subject to separate merge/deployment approval.

Evaluation input SHA-256: `6c3237d7426506c546406c0c4b4706e1b1532e0d2e33a599f7be0f5c34792315`.
