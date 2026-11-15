# Website restoration release — 15 November 2026

This release combines the safe website/research work from PRs #5 and #7 with the requested restoration. PR #6 remains an inactive archive. The deployed account/order files `backend/lib/deriv_demo.py` and `backend/routers/deriv.py` match main commit `a5556bc` byte-for-byte. The new authenticated display-only adapter is separate. No strategy is promoted into Demo execution; the original manual digit buttons, configuration, limits and settlement remain available.

## Restored experience

- Original dark/blue dashboard, live prices, digit trail/frequency, three bot product buttons, manual digits, session statistics/history, Start/Pause/Stop and collapsible comparisons remain.
- Sound ON/OFF is visible and remembered. The original WIN sine tones (880/1318.5 Hz) and LOSS square tones (220/164.8 Hz) remain; result flashes retain green/red outcome colors. Start or switching sound ON unlocks audio on browsers requiring a user gesture. Each new settlement notifies once. Loading history never replays notifications. Zero-profit results are not sounded as losses.
- Authorized Demo selector stays visible, including when only one supported account exists. Switching reuses the server-held authorization, updates the verified account/currency/balance, and does not start orders. The existing execution backend only accepts active USD Options Demo accounts; this release does not broaden that boundary. Other authorized accounts appear as explicitly read-only REST snapshots.
- Separate authorization, market and balance status messages prevent a working price feed from being mistaken for an authenticated account. Display requests have bounded timeouts and an explicit retry. Balance refresh uses the existing authenticated channel without adding subscriptions; account-list snapshots refresh about every 30 seconds. Failed refreshes retain the last successful timestamp and report the error.
- The normal connection popup emphasizes official Deriv login. The private-token alternative is collapsed; no technical callback/setup message appears in the ordinary flow. OAuth/PKCE, scope, public App ID, verification tag and `<site>/api/deriv/callback` remain intact. Tokens stay out of browser storage and virtual history.

## Separate virtual wallet

Starting balance, current balance, available money, reserved stake and virtual net P/L are distinct from the actual read-only Deriv balance. A stake is reserved once and a settlement credited once. For example, 42 × $4.82 − 2 × $50 = **+$102.44**, so a $1,000 virtual wallet becomes **$1,102.44**. No part of that amount is added to the Demo account.

Virtual history and wallet survive page refresh in this browser. Settled sessions restore without sounds; a running virtual session restores paused. Refreshing an open virtual position makes its result unresolved and keeps its stake reserved because the missing observations cannot establish settlement. It is never silently refunded or reported as a win/loss. An explicit new session starts a separately funded virtual wallet and archives the prior one. Up to 20 virtual sessions and the existing 500-row per-session history limit are retained. Clearing browser storage removes this local research history; it is not a server backup or a cross-device wallet. Demo results remain separate.

## Educational research and independent rule check

Six separate display-only categories cover Differs, Accumulator, Multiplier, Matches, Touch and No Touch. They show payout assumptions/source, stake, profit/loss per outcome, break-even, observed win rate, assumed expected value, net P/L, drawdown, sample size/consistency, limitations and verdict. They never configure or execute broker orders.

Official contract definitions confirm that Matches requires the final digit to equal the chosen digit and Differs requires inequality. A theoretical uniform digit has a 10% Matches probability and a 90% Differs probability; historical hot/cold frequency is not evidence that the next digit changes probability. For a binary contract with stake S and gross winning payout G, break-even is S/G, and assumed EV is p(G−S)−(1−p)S. High gross payouts and high win rates alone prove no edge.

Touch succeeds on barrier contact within the specified duration, while No Touch requires no contact throughout. Their probabilities depend on price paths, barrier distance and duration. Any 50% probability displayed here is expressly illustrative, not measured. The model uses observed ticks and saved public quotes, not guaranteed historical executable prices. Accumulator barrier and Multiplier exit/fill approximations remain disclosed benchmarks.

Sources (contract conditions only; authentication still uses the current existing OAuth implementation):

- https://legacy-docs.deriv.com/docs/digit-matchesdiffers
- https://legacy-docs.deriv.com/docs/touchno-touch
- https://deriv.com/help-centre-question/what-is-deriv-bot
- https://deriv.com/help-centre-question/how-do-i-import-my-own-trading-bot-into-deriv-bot

Deriv Bot is a separate visual builder that imports its own XML bot files. Hosting this dashboard on Render and authorizing it through OAuth does not automatically list it in Deriv Bot. The independently hosted website and its existing backend remain the application; no new Deriv Bot import or execution integration is introduced.

## Preserved research evidence

The original PR #7 report and evaluation files are unchanged, including its historical **166-test** count. That is the previous report's count, not this release's test total. Its 20,000 evaluation ticks, four held-out windows, 23 original benchmarks and seven alternatives remain reproducible. The old selector lost **$226.39**; the rebuilt selector returned **NO TRADE in all four windows**. No candidate qualified.

| Original category benchmark | Virtual P/L across independent test wallets | Outcomes | Verdict |
|---|---:|---:|---|
| Differs | −$270.24 | 2,664 | FAILED |
| Accumulator | −$132.18 | 1,316 | FAILED |
| Multiplier | −$42.94 | 107 | FAILED |
| Matches | −$3,397.68 | 2,197 | FAILED |
| Touch | +$23.50 | 95 | INCONCLUSIVE |
| No Touch | −$85.38 | 159 | FAILED |

These totals have different sample sizes and are not a ranking of future returns. Touch had one winning and one losing tradable window; the other two lacked a supported quote. The positive aggregate does not meet sample, consistency or pricing requirements. This restoration summarizes the existing fixed-protocol evaluation; it does not relabel previously examined data as newly unseen or tune strategies against it. The full old/new comparison, risk/reward, losing streaks and drawdown table remains in `REBUILD-V2.md`.

## Validation and release boundary

All **180 automated tests passed: 130 Node tests and 50 Python tests, zero failures**.

The release suite covers original simulation regressions, actual-Demo protocol with local mocks, desktop/mobile layouts, explicit manual-digit submission, read-only account information, HTTP cookie/origin/CSRF protections, balance-refresh races/failures, wallet arithmetic/persistence/deduplication, unresolved funds, sound tones/toggle/replay prevention, bounded account timeouts, all six educational categories, preserved historical evidence, break-even/payout calculations and the actual Render static build. Full-byte comparisons protect both account/order files and the frozen research module/data.

Secret scanning findings were reviewed: the public domain-verification value, Git/evaluation hashes and a deliberately invalid socket URL fixture are not credentials. No private configuration or new dependency is included. Backend tests use local doubles and a synthetic OAuth provider; no provider orders are placed by the checks.

Production checks must verify deployed frontend asset hashes, the new protected display endpoint, existing config/callback routes, desktop/mobile live data, virtual-only controls, notification interface and educational panels. Private account login/switching is covered by controlled tests but requires the user's own authenticated browser for an end-to-end provider check. Speakers/device mute cannot be verified remotely. A backend restart can still require OAuth reconnection because the existing session store is in memory. Render Free cold starts remain possible.
