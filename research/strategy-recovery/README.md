# Original EazyXPro recovery and Deriv integration

This is a review branch, not a deployed or validated profitable trading system.
Base website commit: `12d5fffeee2fe6edddb03536fd16dfad15fbe93d`.
Original source: [eazyxpro/eazyxpro at 5dbfdd5](https://github.com/eazyxpro/eazyxpro/tree/5dbfdd5).

## What was recovered

All 16 requested PDFs (301 pages) were read as extracted text and rendered chart pages. Tall chart lessons were also split into detail tiles. WCFX's damaged text layer required OCR. The full page-labelled text, chart-reading notes, rules and unresolved gaps are in `chartscanner/src/lib/strategy-library.server.ts` (17 independent entries including the complete Pulse Entry SQL seed). No 20,000-character corpus cap remains. `pdf-inventory.json` records the original paths, page counts and SHA-256 hashes; `strategy-notes.json` records chart examples and rule gaps. Original PDF illustrations were reviewed by the developer; they are not attached to each runtime AI request. The prompt includes their recovered descriptions and the full text.

The four original module paths are retained under `chartscanner/src/lib/`. The provider entry point is narrowed to a native-fetch adapter without Supabase/payment dependencies; its unchanged upstream implementation is retained in `chartscanner/upstream/` for comparison. Original EazyXPro Supabase auth, billing and unfinished standalone homepage are not imported into the Deriv website.

| Source | Recovered basis / unresolved information |
| --- | --- |
| Structure First | HTF zone, strong LTF structure clearance, origin-zone retest; stop beyond origin, opposite HTF zone target. No numeric swing/zone definition. |
| CarlFx BluePrint | Sweep, BOS/CHoCH, order block return and reaction. FVG explanation incomplete; MSS wording conflicts. |
| Eagle Way | Respect/disrespect of zones and directional candle close. Exact stop/target rules missing. |
| FSTRADERS | Fibonacci body levels, sessions, sweep/PO3. Missing mentorship chapters and precise stop rule; PO3 labels conflict. |
| Giant Killer | Prior-day levels, M/W second-leg rejection/retest; false-break variant. Precise exits/day boundary absent. |
| Candle Range Theory | HTF range raid and close back, subsequent close or LTF confirmation. Stop beyond raid and opposite-range target. |
| NJAT Structure & Timeframes | Context and timeframe hierarchy; not a complete standalone entry system. |
| NJAT Week 1 Observation | Observation context; hindsight-selected examples do not establish profitability. |
| One Pattern One Million | HTF impulse/correction, MA and structure confirmation, retest. No precise protective stop; source risk escalation not enabled. |
| Price Order Delivery | Delivery/structure context; no complete standalone entry/exit rules. |
| Pabifx Domain 2 | NASDAQ context, sessions and zone/pattern examples. Cannot assume stock-session rules apply to Deriv synthetics. Mislabels/unsupported success claims flagged. |
| WCFX Supply & Demand | Base patterns, trend-aligned return, proximal/distal boundaries and outside stop; target descriptions retained. OCR may contain transcription errors. |
| Lesson 2 Trading Tactics | Fresh H4 supply, weekly context and inside-bar break; outside stop and support target. Misleading source sizing claims flagged. |
| Lesson 3 Trading Tactics | Supply confirmation; textual target conflicts with the chart. The missing resolution is not invented. |
| Lesson 3 Engulfing Bar | Range-engulfing confirmation at zones. Early source direction/zone labels conflict with later examples. |
| Lesson 4 Higher Timeframe Ranging | H1 pullback, D1 range/double-bottom context, tailed confirmation, outside stop and resistance target. |
| Pulse Entry SQL seed | Zone → clear push away → return INTO zone → confirmation inside. Supplemental confluence, not an independent entry vote. |

The original heuristic scoring, grades, 3-strategy/8-confirmation high-conviction threshold, 2-strategy clear-structure medium threshold and WAIT/INVALID_SETUP/NO_STRATEGY_MATCH outcomes are enforced in code. Duplicate chart events, unseen source pages, wick-only BOS and missing evaluations cannot inflate the score. Follow-up analysis reads fresh images rather than assuming a previous trade exists. These checks validate an AI evidence record's structure; they do not independently prove that the model saw the market correctly. No profitability or win-probability claim is made.

## Automatic Options Multipliers path

Disabled by default, with separate backend Demo and Live flags. The existing OAuth callback, account display, original Demo execution module, sound generator and frozen research remain unchanged. Enabling the new path replaces the visible Digit practice panel with account/market selection, fixed stake, session profit target, total loss limit and Start/Pause/Stop. Real-account execution additionally requires its server flag and an explicit checkbox. Only active authorized **USD Options accounts** and the existing supported volatility markets are accepted.

The server fetches real D1/H4/H1/M15 closed candles, renders the four charts and checks once per new closed M15 candle. This is a timeframe subset, not a claim that missing M1/M5/weekly/DXY/news charts exist: any strategy requiring unavailable evidence must be unverifiable/WAIT. Indicator-only, context-only, incomplete and conflicting setups cannot force an order.

Only an immediate original-policy BUY_NOW/SELL_NOW interpretation can be considered. At least two matching entry strategies and a source with explicit exits are required. Entry, invalidation and target anchors must resolve to actual closed OHLC values; model-supplied arbitrary prices are ignored. This anchor representation deliberately cannot execute every possible discretionary zone. A missing representable complete setup means no trade. The lowest provider-listed multiplier is used, not loss recovery. Provider commission, available leverage, two authenticated quotes, exit barriers and settlement determine all monetary amounts. No Digit, Accumulator, fixed-duration option or Martingale execution is added.

Pause/Stop block new entries, including delayed AI/quote/ledger responses. They **do not close an existing broker contract**; the attached provider stop/target stays in force and monitoring continues. Full-stake exposure must fit the remaining loss allowance. A target can be overshot by a settlement, and external/manual account activity is not included in this bot session's P/L. One account lock prevents simultaneous old/new broker sessions. Unknown purchase responses never retry. Restart recovery monitors acknowledged contracts only, never resumes entries, and preserves unresolved locks for statement reconciliation. A different worker must wait five minutes after the last heartbeat. An unknown purchase with no contract ID requires provider-statement investigation; the UI does not release its lock on guesswork.

## Verification

Controlled mocks cover both account types, CSRF, fixed stakes, source anchors, actual quote/settlement accounting, session limits, delayed response cancellation, ownership, recovery and no retry after unknown purchases. Browser checks cover phone overflow, actual account display remaining separate, selected account requests, Live selection, controls, refresh and feature-off compatibility. No authenticated Demo or Live orders were sent. No AI-provider key was available to verify real model access or output quality. Public Deriv WebSocket checks confirmed candle history, MULTUP/MULTDOWN availability, provider multiplier ranges, commission and proposal limit fields; these are read-only checks, not proof of authenticated execution.

See `chartscanner/README.md` for deployment preparation and the final test totals. Strategy profitability, autonomous chart-recognition quality and authenticated broker execution remain unverified. This branch is not ready for unattended Live activation.
