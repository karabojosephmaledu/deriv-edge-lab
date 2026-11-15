# Deriv Edge Lab — research and account review

This branch is a review candidate. It has not been merged or deployed. The live website remains at PR #4. Existing Demo contracts are separate from all new virtual comparisons.

## What was wrong

The small-win/full-stake-loss structure is a financial risk, not proof of incorrect settlement. With a $50 stake and a $5 win, one full loss erases ten wins and break-even requires 90.91% wins. Commission makes the required price move larger. A different reward/risk ratio does not by itself add a predictive edge.

The user's actual Demo example is more demanding: $200 stake and $15.05 profit per win require **93.00%** wins if losses cost the full stake. One full loss erases **13.29** such wins. Assuming independent uniform last digits, Differs wins 90% and that particular payout would imply an average loss of about **$6.46 per $200 entry**, not a guaranteed loss on any particular trade.

The public preview showed $19.30 profit while authenticated settlements paid $15.05. These are different pricing sources; the exact account/app-specific pricing difference was not independently diagnosed. The old UI already called its public figure an estimate, but it was an unsuitable reference for actual Demo results. This branch stops displaying that public estimate in Demo mode. It stores the authenticated entry quote, displays the last actual winning settlement when available, and calculates the reference break-even rate from that source. Before such data exists it shows “Quoted at entry”; variable Accumulator/Multiplier returns are not presented as fixed winning payouts. Quotes and future returns may change.

The account dialog also incorrectly said credentials stayed in the browser and that the app was always view-only. Credentials have been held in backend memory since PR #4; connecting alone submits no order, but explicit Demo mode and Start can. The wording now matches that behaviour.

## Changes and completion checklist

| Request | Status in this branch |
|---|---|
| Existing official Deriv login/callback | Preserved; public configuration and Demo enablement verified live. The user reported successful authorised Demo contracts and balance changes. No independent login or broker-statement check using the user's credentials was performed. |
| Demo and Real account identification, balances and currencies | Added a REST-only, timestamped list of authorised active accounts, refreshed about every 30 seconds. Real accounts never become execution selections. |
| Secure credentials and clear connection button | Preserved server-side credentials, HttpOnly cookie, CSRF and origin checks. Corrected stale instructions and added an independent Deriv portal tab link. |
| Manual digit selector removed | Removed the ten clickable digit buttons and numeric keyboard selection. |
| Automatic digit choice | Added a 50-tick least-frequency rule, lowest-digit tie break, and a visible warm-up/choice status. Demo uses authenticated backend ticks and verified precision; the browser cannot supply the chosen digit for this mode. No entry before 50 observations. This is an experimental heuristic, not a proven predictor. |
| Digit Differs research | Fixed, seeded-random, cold-25 and cold-50 references. |
| Over/Under research | Over 1, Under 8, and the prior-two-0/1-digits filter compared with unfiltered references. |
| Rise/Fall research | Five-tick CALL/PUT with EMA 9/21 and EMA 20 + Wilder RSI 14. Plain-contract ties lose; allow-equals contracts are not silently substituted. |
| Digit Matches research | Fixed, frequent-digit windows 50/150/200, and agreement between all three. |
| Touch/No Touch research | Upper relative barrier and 120-second horizon. Exact barrier contact counts; unavailable proposals stay unavailable. |
| Accumulator review | Original growth/barrier baseline and calm-entry comparison retained as approximations. No invented small stop-loss on a knockout contract. |
| Multiplier review | Original baseline, EMA entry reference, and an experimental 10%-of-stake stop / 20% target. Exits use the observed tick, including overshoots; a stop is not a guaranteed maximum loss. |
| Flat / Paroli / Martingale | Separate virtual comparisons: flat, Paroli capped at two or three levels, Martingale capped at three levels as a risk example only. No staking model reaches Demo execution. |
| Small virtual wallets | $1, $2.50, $5, $8, $10 and larger balances. Reserve stakes, refuse insufficient funds, respect configured contract floors, never create credit or silently raise a subminimum stake. |
| Session targets/loss limits | Independent research limits, with full-stake exposure checked before entry. Existing Demo/session safeguards preserved. |
| Unseen data and payout provenance | Dated public snapshots, fixed training/validation/holdout split, next-tick simulated fills, boundary buffers, current-versus-historical quote distinction, recorded missing models. |
| Preserve design and working strategies | Existing layout/palette/live feed preserved; the optional comparison panel grows. Existing settlement/payout mathematics is unchanged; automatic digit selection is an intentional entry-policy change requested by the user. |
| Tested, pushed, PR | See the PR validation section. All new work awaits merge/deployment approval. |
| Proven profitable strategy | **Not established.** No model is automatically promoted from a favourable backtest to account execution. |
| Three months of forward testing | **Not completed.** Requires new observations over time; historical replay cannot substitute for it. |
| Real-money order execution | **Not implemented.** Server-side Real-account and Real-WebSocket rejection remains. |

## How the studies work

`frontend/public/research.js` is a dependency-free pure engine. It cannot access credentials, browser storage or the network. The dashboard supplies only public tick history and read-only proposal responses. Its wallet never uses or changes the connected Deriv balance. The old optional replay remains available and now clearly identifies current quotes and fallback assumptions.

All indicators and digit counts use only prices already observed at the signal. Entry is delayed to the following tick. Digit contracts settle on the tick after that entry. Only one virtual position is open; a settlement tick cannot also create a new signal. Rise/Fall uses five post-entry ticks. Touch/No Touch checks the whole observed path against the barrier and duration.

Each dated 1,000-tick window uses the first 40% for training references (after a 200-tick warm-up), the next 20% for validation, and the final 40% as held out. Candidate settings were fixed before inspecting outcomes. A conservative maximum-duration buffer stops contracts crossing phase boundaries; long-duration contracts may have too little validation data in these short windows. No hidden forced closing at a boundary creates a winning result.

The comparison can identify a candidate using validation only: at least 30 completed trades, positive net P/L, no unresolved validation position, and observed drawdown at most 25% of the virtual starting balance. These are screening criteria, not statistical proof. The held-out results never choose the candidate. A failure to qualify produces an abstention message. Displayed alternatives remain research references and do not change the live account's strategy.

Binary gross returns are rounded to cents before net profit and break-even calculations. Different stakes use snapshot payout ratios approximately; progressive stakes may have different real pricing. Binary contract pricing already contains its cost; no additional invented commission is deducted. Multipliers include the quoted entry commission once. Accumulator barriers/growth and Multiplier prices/fees remain approximate historical models, not Deriv-settled contracts.

Break-even for fixed binary gross payout `P` and stake `S` is `S / P`. For variable returns, the empirical loss/(win+loss) ratio uses observed average win and average loss and is absent when one side has not been observed. It is a description of that outcome mix, not a stable future win-rate requirement. Zero results are break-even, not losses. Open binary positions have unknown final P/L and are valued at entry cost for equity; worst-case exposure remains the stake. Multiplier/Accumulator drawdown includes observed open P/L.

Paroli doubles exposure after wins and resets after the selected two/three levels or a non-win. Martingale doubles after losses, resets after three levels or a non-loss, and stops if the wallet cannot fund the next stake. Three successive losses can cost seven base stakes; with a small winning payout, even the next win may not recover prior losses. Neither changes the underlying contract's expected return.

## Observed results — no profitability claim

The versioned public input contains **6,000 ticks**, two markets (`R_100`, `R_25`) and three non-overlapping dated windows on **13, 14 and 15 November 2026**, around 08:52–09:25 UTC. The snapshot anchor is 15 November 2026 09:26:19 UTC; individual proposals carry their own capture times. Initial capture validation caught responses outside the requested dates. The collector now sends explicit start/end bounds, uses the schema's string end timestamp, and refuses mismatched or overlapping windows. Failed rate-limited reads were retried serially; successful reads were kept. Two genuine unavailable quotes remain: the small R_25 No Touch quote offered no return; the large R_25 Touch quote exceeded the provider payout cap. No substitute was fabricated.

These are short samples, not three full days of data. Quote snapshots were collected later than the historical signals, so **all replay returns are estimated scenarios using current public pricing**, not evidence that those prices were executable in the past or for the user's authenticated account.

The table sums six **independent held-out runs**, each starting at $1,000 with $50 base stake and flat staking. Wallets reset between runs; this is not one continuous account curve. Drawdown is the worst individual window. The complete per-wallet/per-phase matrix is generated by the reproducible evaluator.

| Study | Completed trades | Sum of estimated net P/L | Worst window drawdown |
|---|---:|---:|---:|
| Differs fixed 5 | 798 | -$539.24 | $310.22 |
| Differs cold 25 | 798 | -$594.06 | $434.26 |
| Differs cold 50 | 798 | +$8.96 | $333.68 |
| Over 1, unfiltered | 798 | -$611.96 | $546.22 |
| Over 1 after two 0/1 digits | 62 | +$286.90 | $88.42 |
| Under 8, unfiltered | 798 | -$981.44 | $534.64 |
| Under 8 after two 0/1 digits | 62 | -$144.16 | $165.26 |
| Rise/Fall EMA 9/21 | 342 | -$986.28 | $718.77 |
| Rise/Fall EMA 20 + RSI 14 | 325 | -$1,698.95 | $749.02 |
| Matches frequent 50 | 328 | -$4,792.82 | $1,414.28 |
| Matches 50/150/200 agreement | 185 | -$1,214.26 | $1,353.57 |
| Touch | 29 | +$142.64 | $111.52 |
| No Touch | 47 | -$283.87 | $241.05 |
| Accumulator original target | 329 | -$579.04 | $311.36 |
| Multiplier original target | 27 | -$98.72 | $49.56 |
| Multiplier EMA 10% stop / 20% target | 50 | -$145.32 | $53.25 |

The validation-selected candidates lost **$626.82** in total across the six $1,000 held-out runs, worse than keeping the fixed-Differs reference in this sample. A “more intelligent” selector is not automatically an improvement.

The automatic cold-50 rule won 728/798, or 91.23%; its approximate 95% Wilson interval is 89.06–93.00%, including the uniform-digit reference of 90%. Its tiny estimated aggregate profit under public pricing does not establish an edge and does not imply profit at the user's lower authenticated payout. The Over-1 filter won 55/62; its interval is approximately 78.48–94.42%, which includes the unfiltered fair-digit reference of 80%. These intervals assume independent binary outcomes and are only descriptive: overlapping observations, multiple comparisons and changing prices add uncertainty. Matches agreement won 18/185 (9.73%), giving no demonstrated improvement over the 10% reference. The risk-adjusted Multiplier candidate lost in all six windows. It is not promoted as an improvement.

There are 36 wallet/window cases: five small balances with $0.35 base stake, and the $1,000/$50 case, for each market/date. Each case contains 23 strategies across three phases and four virtual staking models. Twenty-five cases qualified a candidate on validation, but qualification did not reliably survive the holdout. These small, related cases do not provide 36 independent confirmations.

## Account/API compatibility and live status

The existing OAuth authorization-code flow, PKCE S256, state verification, registered HTTPS callback and backend code exchange match Deriv's current documentation. GET `/trading/v1/options/accounts` currently requires the `trade` scope. PAT REST requests require the `Deriv-App-ID` header. A broad provider scope does not mean this research engine has account-order access; Real order endpoints and URLs remain blocked.

The public `/api/deriv/config` endpoint returned HTTP 200 and `demo_execution_enabled: true` through both the backend and frontend after the user updated the correct Render backend. The user's subsequent dashboard reported four actual Demo wins and a balance increase of $60.20. Those observations support the Demo flow working, but do not independently verify the official broker statement. No account credentials were requested or used by this investigation and no account orders were placed by the development/test tools.

The new Real-account view uses only the authorised REST listing, not a Real WebSocket. It keeps its last successful timestamp on failure. The execution account selector contains only active USD Demo accounts. A usable USD Demo account is still required by the existing login/session flow; Real-only account login is not added. Credentials live for at most one hour in backend memory; a worker restart/expiry requires reconnecting. Render Free availability and session expiry are not solved by switching to a Real account and do not guarantee three months of continuous unattended operation.

Official references checked:

- [Deriv authentication and app types](https://developers.deriv.com/docs/intro/authentication/)
- [Deriv OAuth with PKCE](https://developers.deriv.com/docs/intro/oauth/)
- [Authorised Options account listing and scope](https://developers.deriv.com/docs/options/get-accounts/)
- [Public proposal endpoint](https://developers.deriv.com/docs/trading/proposal/)
- [Official request/response schemas](https://github.com/deriv-com/deriv-api-schemas/tree/44dd4457b82582f68b2ace2f4b8cf9ff1db44481)
- [Official Rise/Fall contract conditions](https://legacy-docs.deriv.com/docs/risefall)
- [Official Touch/No Touch contract conditions](https://legacy-docs.deriv.com/docs/touchno-touch)

## Tests and reproduction

The review run passed **95 Node checks and 47 Python checks (142 total)**. Coverage includes the existing six simulation-integrity fixes, payout/commission/precision regressions, cold-50 warm-up on both sides, server-side Demo selection, unknown/missing tick rejection, no future data in validation selection, funding/ledger reconciliation, staking exposure, realistic stop overshoots, actual-settlement ticket display, desktop/mobile research UI, account-view refresh failures, a public-read allowlist covering saved-snapshot retries, and existing OAuth/CSRF protections. All order-path tests use mocks. New production account viewing and automatic Demo choice still require acceptance after an approved deployment.

Offline reproduction using the current dependencies:

```bash
node --test --test-concurrency=1 tests/simulation.test.cjs tests/simulation-browser.test.cjs tests/demo-browser.test.cjs tests/deployment.test.cjs tests/research.test.cjs
node scripts/evaluate-research.cjs
cd backend
python -m pytest tests/test_demo_execution.py
```

The evaluator writes `research/results.json` (generated and ignored), using the versioned `research/public-sample.json`. Refreshing public data is optional and changes the experiment; it is not required to run tests:

```bash
python scripts/capture-research.py
```

Run the collector with the existing backend Python environment. It has an explicit public-read allowlist and uses serial paced requests. No paid service or new dependency was introduced.

Before an approved backend update, stop new Demo entries and allow any open contract to settle. After deployment, reconnect and verify the read-only account list, automatic 50-tick warm-up and minimum-stake Demo result against Deriv. The live site has not been changed by this branch.
