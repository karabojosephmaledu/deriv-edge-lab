# Simple automatic Matches practice

The normal page now contains only the authorized account/balance selector, live market/prices and last digits, stake, target, loss limit, Start/Pause/Stop, an automatically chosen digit and a single practice-results summary. The Video Growth preset, manual digit selector, research panels, saved-history selectors, transaction tables, duplicate provider-results panel and frequency chart are removed from the normal page. Historical source/data and local browser records are not deleted. No replacement wallet or hypothetical starting account balance is added.

## Automatic selection

The practice bot looks for one common most-frequent digit in the last 50, 150 and 200 observed digits, matching the previously supplied video's frequency-agreement idea. If there is not exactly one common candidate, it waits without creating an entry. It does not silently choose digit zero or another arbitrary fallback. A public history request can initialize the observations; malformed/conflicting history is rejected and observations are otherwise collected from the live stream. History timestamps beyond the latest observed live tick cannot choose a current entry.

A selected digit is frozen before requesting its public quote. The quote is for the configured fixed stake and that digit. A later live tick opens the virtual position; the following consecutive tick settles it. A matching final digit earns the quoted gross return minus stake; a different digit loses the full stake. Price quotes never buy contracts. Missing prices/quotes, stale frames and interrupted results cannot produce fictional wins. Settings and the market stay locked while active, Pause prevents entries, Stop waits for a pending result, and full-stake exposure is checked against the total loss limit before entry. Existing target, loss-limit, sound and refresh safeguards remain.

Both stake and all P/L are USD practice values. The interface defaults to a $0.35 fixed practice stake and $1 target/loss limit, all editable before Start. There is no Martingale, growth stage or loss-based stake increase in the normal interface. Genuine Demo/Real balances come only from the existing authorized provider display, with account switching and refresh unchanged. Real accounts remain view-only. No backend, OAuth callback, secret setting or order-execution implementation changes.

## What this does not prove

Automatic digit selection is a frequency heuristic, not a demonstrated predictive advantage. Past frequency does not establish a higher next-digit probability on independent uniform digits. The existing negative/inconclusive research record is preserved; it is not converted into a profitability claim. A target is a stopping rule, not a promised return. This release cannot honestly promise to double a $5 or $10 account and does not start account orders. The page plainly identifies practice mode rather than presenting its P/L as changes to a genuine balance.

## Validation

All **255 automated checks passed: 178 Node/browser and 77 Python**, with final targeted checks after the history-retry correction. Tests cover:

- Minimal current desktop/mobile UI, automatic selection without manual input, genuine account selection and unchanged balances during practice.
- Agreement, disagreement/ties, warm-up failure, future-observation exclusion, fixed stakes and digit freezing before the fill tick.
- Public payout validation, win/loss arithmetic, target/loss limits, pending Pause/Stop, delayed quotes, refresh, unknown outcomes and sounds without replay.
- Existing authentication, read-only Real account protections, legacy simulation and research regressions, source preservation and Render static build.

The previous manual/preset dashboard and controller are frozen as test fixtures so its regression tests remain reproducible. A separate current-page browser suite tests the simplified production interface; archived UI tests are not represented as current-page verification.

Production checks separately verify deployed file hashes, live public ticks/history, automatic selection or its honest waiting state, controls, ordinary recorded outcomes where available, desktop/mobile layout and JavaScript errors. Private provider balances/history still require the owner's signed-in browser. Development/verification tools do not place provider orders.
