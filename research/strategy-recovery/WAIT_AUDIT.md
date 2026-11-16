# Why the selected-market session waits

The user's screenshot shows 12 markets selected and a running session with recent check timestamps. The individual “Latest market checks” rows are collapsed, so this audit does not claim to have inspected the private session, account authorization, quotes or orders. Public configuration confirmed local rules, a 60-second check cadence, Demo enabled and Live execution disabled.

## Confirmed implementation causes

- The only executable local pattern combines CRT with Giant Killer's three-opposite-candle reversal. Giant Killer is explicitly restricted to M15/H1 by its source; checking M1 candles every minute does not change those entry timeframes.
- The final confirmation must have just closed on M15/H1. Entries also need the prior-day level, range raid and close-back, three opposite bodies, directional high/low structure, an unvisited target and the unchanged evidence policy. These are selective conditions, not a trade-per-minute system.
- The original implementation additionally required the range low/high to **equal** the prior-day low/high. The documents do not prescribe exact OHLC equality. A real test through a level was incorrectly excluded.
- Fifteen of the 17 preserved source records are reference/unverifiable, not extra executable strategies. More selected symbols cannot turn those records into entry signals.

Calling this implementation fast M1 scalping was inaccurate. The timing mismatch is separate from market connectivity, and the public tick connection alone does not verify an authenticated account connection.

## Public-data trigger audit

Public Deriv candle snapshot: **2026-11-16 14:29:33 Africa/Johannesburg** (epoch `1794832173`). Markets: XAUUSD, BTCUSD, R_10/25/50/75/100 and their five 1HZ counterparts, matching the 12 selections visible in the screenshot. No authenticated requests or broker orders were used.

A 48-hour M1 history request was capped by the provider. The actual returned observations were 749 closed M1 candles for Gold and 999 for each other market, approximately 12.5 and 16.7 hours respectively. This is **not a complete 48-hour backtest**. D1/H4/H1/M15/M5/M1 histories were cut to information available at each evaluation time, with at least 60 closed candles per frame. The same eligible windows were used before and after the correction; no future bars were included.

| Measure | Production equality rule | Corrected level-test rule |
| --- | ---: | ---: |
| Recent closed M1 observations considered | 11,738 | 11,738 |
| Eligible M15/H1 source windows | 808 | 808 |
| Windows passing the level condition | 4 | 38 |
| Complete entry interpretations | 0 | 0 |
| Entry interpretations in final hour | 0 | 0 |

In the corrected version, four windows completed a raid/close-back but failed later reversal/structure requirements. No market produced a complete eligible entry. Correcting equality alone therefore does **not** solve the desired frequency. The same sample informed this diagnostic correction; it is not unseen validation of a new strategy or evidence of profitability. There are no historical authenticated quotes, executions, commissions, P/L or win-rate conclusions in this audit.

The local public input and replay artifacts are preserved under `/tmp/deriv-wait-audit/` in this workspace. Input SHA-256: `17cd6ae40b8cfc960d9b275bc32275e067e3112f71a87791491856f2e8e5b60c`. Production baseline commit: `ed226a2c64651c4303fc4edb5d7b2d0271f0b17a`. Temporary artifacts are not a durable external dataset.

## Correction prepared for review

The range candle now reaches or crosses the actual daily level and closes on the valid side; the raid must reclaim that level and close inside the range. No arbitrary zone tolerance or new M1 entry pattern was added. The original source timeframes, three-candle confirmation, entry/exit anchors and evidence policy remain.

Local results expose per-timeframe reasons: source candle still open, prior-day context not ready, level not tested, raid/close-back missing, or reversal/structure not confirmed. Per-market status retains those reasons; the page displays the next source-close time between source closes. WAIT outcomes do not enter the quote/order pipeline, so stale-price errors do not replace the missing-pattern explanation.

Existing account/OAuth code, provider quotes, payout/commission calculations, buy/settlement/monitoring code, fixed-stake controls, sounds, design and Live feature flag are unchanged. No deployment or authenticated execution is part of this correction.

Validation: 46 scanner tests, 77 automatic-session backend tests and 15 browser tests passed (138 relevant tests total), including five new regression cases. TypeScript worker type-check and `git diff --check` passed. The historical benchmark suites were not repeated because no benchmark/simulation formulas changed. Browser tests use controlled data and forbid actual broker orders; they do not verify a private live account session.

A separate M1 strategy would require an explicit mechanical definition and virtual evaluation before any Demo execution connection. It cannot be described as the unchanged original M15/H1 strategy or promised to trade every minute or grow an account.
