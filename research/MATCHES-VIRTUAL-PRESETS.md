# Restored Digit Matches virtual testing

The existing website now has a compact live-data Matches testing card with Start, Pause, Stop, an explicit match digit, session profit target, total loss limit, wins/losses, win rate, P/L and a separate virtual history. No new wallet card or account funding is introduced. Existing genuine Demo/Real balance, selection, provider transaction history, OAuth callback, sounds and dark-blue layout remain. Backend files and the original execution engine are unchanged.

## The two presets

**Fixed-Stake** uses the selected digit and identical configured stake for every entry. No increase follows a loss or a win.

**Video Growth Strategy** reproduces the requested hypothetical stages, starting each new independent experiment at $47:

| Virtual experiment level | Virtual stake |
|---|---:|
| Below $100 (starts at $47) | $1 |
| $100 to below $200 | $2 |
| $200 to below $500 | $5 |
| $500 to below $1,000 | $10 |

The stage is calculated from $47 plus settled virtual session P/L, never from a connected account. A fall below a threshold lowers the next stake. There is no loss-recovery escalation, doubling or Martingale. The experiment stops at $1,000, when its remaining hypothetical funds cannot cover another stake, at an applicable session limit, or at the background 1,000-outcome session cap. These are a simulation's rules, not achievable-return promises. Session targets are net profit targets, distinct from stage-level milestones.

The provided videos describe stake milestones and a historical-frequency selection example. They do not establish a verified forecasting edge or guaranteed payouts. Both implemented presets keep the match digit explicit and fixed during the session; this release does not claim to reproduce the video's AI tool or automate its hot-digit claims.

## Pricing and settlement

Each prospective entry requests a fresh, **public, unauthenticated DIGITMATCH proposal**, for the actual virtual stake, digit, market, USD currency and one-tick duration. The request obtains a price, never buys a contract. The displayed gross return, winning profit and break-even rate use that proposal. Missing, expired, malformed, wrong-stake or mismatched proposals create no result and stop entry. There is no 8x/9x fallback or copied video payout.

An entry fills on a live tick after the quote arrives; its outcome uses the following chronological tick of the same market and precision. The first digit cannot settle its own entry. An equal final digit wins gross payout minus stake; any different digit loses the full stake. Decisions never inspect a future observation. Duplicate, delayed and other-market ticks cannot settle twice. A quote is consumed once and expires after ten seconds.

This is a causal **virtual pricing/fill model**, not a claim that the provider would execute that historic quote at that tick. Quote latency, live contract availability and actual provider fills can differ. No account contract is created. A ten-percent win rate is not automatically profitable: at an illustrative 8.33x gross return, ten wins and ninety losses on $1 stakes lose $16.70. No outcome or provider payout is adjusted to make results attractive.

Pause prevents entries while an existing position still settles. Stop prevents new entries and waits for the pending one-tick result. A target/loss limit reached during pause or stopping ends the session. A full-stake loss is reserved against the configured loss budget before opening; a position that could breach it is not entered. Settings/market remain locked while a session or pending position is active. A completed session can be explicitly restarted as a new experiment with clean counters, while the prior session is archived.

Missing ticks, changed precision, disconnection or ten seconds without fresh observations stop the session. Open outcomes become **unresolved**, never invented wins, losses or refunds; P/L is labelled incomplete. Refresh restores settled history paused, without replaying sounds or resuming entries. Refresh during an open position records one unresolved result. Corrupt or non-reconciling saved results are rejected. Up to 20 previous sessions and the last 500 rows of each session remain local to this browser, alongside the older saved-research section.

## Verification

The full existing Node/browser and Python suites passed. Additional checks cover actual next-tick timing, payout validation, constant stakes, all four growth boundaries and step-downs, target/loss limits during pause, Stop/restart isolation, missing/duplicate/foreign ticks, precision, interrupted outcomes, persistent history, different-market restoration, stale quote cancellation, sounds, mobile layout and unchanged genuine account data. Final targeted checks cover the last quote-cancellation/persistence corrections. The current suite has **243 unique passing tests: 166 Node/browser and 77 Python**, with zero unresolved failures.

A local desktop/mobile smoke check also ran both presets on actual public Deriv ticks and public quotes. It included both losses and a match win; that is a functionality check, not evidence of profitability. Production verification separately checks deployed asset hashes, both preset controls, public quotes/ticks, virtual settlement, account API/callback availability, desktop/mobile overflow and JavaScript errors. Private authenticated balances/history still require the owner's browser; their backend has not changed.

Official sources: [public price proposals](https://developers.deriv.com/docs/trading/proposal/) and [Matches settlement condition](https://legacy-docs.deriv.com/docs/digit-matchesdiffers). The latter is used only for the contract condition; existing current OAuth authentication is preserved.
