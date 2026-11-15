# Account-centered correction — 15 November 2026

## Confirmed cause

The working actual-Demo baseline is main commit `a5556bc` (PR #4). Its frontend already initialized `execution: "simulation"`; the latest pre-correction release `fae1746` did too. Actual entries were sent only after choosing **Deriv Demo** and pressing its explicit Start control. Selecting Simulation produced local research outcomes, never provider transactions. The phrase **Running · virtual** was emitted by `renderControls()` for that simulation mode.

PR #8 did not remove or change either execution file: `backend/lib/deriv_demo.py` and `backend/routers/deriv.py` are identical to the working baseline. PR #9 only corrected mobile header layout. PR #8 added the prominent $1,000 virtual-wallet card and persisted local research sessions, making the wrong activity the focus for an account-centered experience. That was a presentation regression. The deployed config checked before this correction returned both `oauth_ready: true` and `demo_execution_enabled: true`; execution was not disabled by that setting.

Originally, OAuth/PKCE exchanged a code server-side, created an HttpOnly cookie, listed authorized Options accounts, selected an active USD Demo account, and obtained its authenticated Demo socket through an OTP. The socket subscribed to the actual balance. Genuine Demo buys/settlements changed the provider balance; frontend account polling displayed it independently of virtual results. The existing `/account` selection called the Demo broker's `select`, which reset its run state and rejected Real accounts. Other authorized accounts had only a separate read-only list. Backend sessions remain in memory: a backend restart can require login again. These are confirmed code behaviours, not a diagnosis of the owner's private current session.

## Corrected website

The existing account card, dark-blue styling, header, live market selector/prices, last ten digits, digit frequency, original sound generators/toggle, secure login and registered callback remain. The new page uses the existing display components without loading the legacy trading/simulation entry point. The original `app.js`, research engine and both Python execution files remain byte-for-byte unchanged and have regression coverage.

The large virtual-wallet card is gone. There is no replacement wallet or synthetic balance. Other strategy controls/comparison panels are removed from the current interface. **Digit Matches is the only current research category**, collapsed separately from the account view. Prior local research session statistics/history remain in their own clearly labelled, read-only section; original archived research files are retained. Historical records and genuine provider descriptions can still name the contracts that actually occurred; they are not active strategy choices.

Authorized **Demo and Real Options accounts** share one account selector. Selection requests the display endpoint with the authorized account ID; it does not invoke broker account selection, reset a Demo run or submit an order. The selected ID survives refresh in this tab. Currency, balance verification time and independent account/market states are visible. There is no credential in browser storage. The original OAuth App ID, callback `/api/deriv/callback`, PKCE and authorization scopes are unchanged. The existing authentication backend still requires an active USD Options Demo account to establish its session; this correction does not rewrite that protected login implementation to support Real-only users.

## Genuine provider data and read-only boundary

The new authenticated `/api/deriv/account-display` adapter verifies account ownership against Deriv's active account list. For the existing connected Demo account it reuses its authenticated channel for reads; other authorized accounts use a separate observer socket. The observer verifies the official host, account-specific Demo/Real endpoint and OTP query, and accepts only three exact fixed requests: `balance`, `statement` (50 records) and `profit_table` (50 records). It has no order/proposal/update/reset/transfer command. The public browser socket accepts only market-data operations. The current page has no execution controls or request path into `/demo/*`.

Balance values come from the selected authenticated provider response with currency/account checks. They are not derived from research P/L or transaction sums. Current balances refresh about every eight seconds while visible; recent history refreshes about every sixteen seconds, with server throttling. Failed refreshes retain explicit timestamps and warnings; unverified or unauthorized records are never replaced with fictional values. Explicit upstream authorization rejection requires login again. Idle observer connections are closed and are also cleaned up on shutdown/expiry.

Transaction history shows up to 50 actual statement entries, including signed amounts and provider `balance_after` values. A buy debit is not classified as a trading loss. Wins/losses/net P/L are calculated separately from up to 50 **settled** provider profit-table entries using `sell_price − buy_price`; open contracts are excluded. These are recent settlements, not lifetime or virtual-session statistics. Permission/format failures are explicit; no undocumented legacy account identifiers or manually entered balances are required.

Original WIN/LOSS tones and flashes notify only newly observed, nonzero genuine settlements; duplicate polls, account switches and page reloads do not replay old results. The saved sound setting is retained. Browser audio needs a user gesture and is subject to device volume/mute.

**This is an account-display correction, not a trading activation.** The unchanged original Demo engine does not implement Digit Matches. Matches remains historical research only because the request explicitly prohibits adding or activating order execution. Real accounts are always view-only in this interface.

## Verification and limitations

All **220 automated tests passed: 143 Node/browser tests and 77 Python tests, zero failures**. The complete applicable suites cover including controlled current-page desktop/mobile flows, provider-like account/statement responses, external balance changes, Demo/Real selection without orders, refresh/session reuse, rejected account IDs, revoked authorization, partial failures, same-account stale responses, disconnect races, history semantics, sound deduplication, original execution/source preservation, legacy simulation/research regressions and the actual Render static build. Legacy browser regressions use a frozen copy of their original markup; current production behaviour has its own account-dashboard browser suite. No package, paid service or secret configuration is added.

Checks never place provider orders. Private authenticated production balances and statements require the owner's own browser session; mock success does not establish that the provider grants that session history access. Production verification separately checks the exact deployed assets, protected display route, OAuth config/callback and actual public ticks on desktop/mobile. Clearing local browser storage still removes its saved historical research records. Unsupported history permissions or absent provider records are shown honestly.

Official sources checked for this implementation:

- [Current API architecture and authenticated Demo/Real endpoints](https://developers.deriv.com/docs/intro/api-overview/)
- [Balance](https://developers.deriv.com/docs/account/balance/)
- [Statement](https://developers.deriv.com/docs/account/statement/)
- [Profit table](https://developers.deriv.com/docs/account/profit-table/)
- [Official production request/response schemas](https://github.com/deriv-com/deriv-api-schemas/releases/latest/download/schemas.zip)
