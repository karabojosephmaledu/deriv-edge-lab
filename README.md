# Deriv Edge Lab

An account-centered dashboard for Deriv Options accounts, with live public market data and separate historical Digit Matches research.

- Genuine authorized Demo and Real balances, currency and recent transactions; Real accounts are view-only.
- Original dark-blue styling, public ticks, last ten digits, digit frequency and WIN/LOSS notification sounds.
- Digit Matches historical research and previous local research records stay separate from account information. No replacement virtual-wallet card.
- Existing Demo execution and simulation code is retained unchanged for preservation/regression checks. The current account-display page does not load that entry point or start orders.
- No paid AI services, new dependency or Emergent credits are required.

## Current account-centered website

The deployed page focuses on genuine authorized Demo/Real account balances and read-only provider activity. Digit Matches is the only visible research category; it never starts orders. The large virtual wallet and other strategy controls are removed from the current interface. Original execution/simulation source remains preserved separately and is not activated by this page. See [the account-experience investigation](research/ACCOUNT-EXPERIENCE.md) for the confirmed cause, source-preservation boundary, supported data and limitations.

## Structure

```
frontend/index.html          markup (the app)
frontend/public/styles.css   styling
frontend/public/account.js   current account display + public market data
frontend/public/app.js       preserved legacy Demo/simulation entry point
frontend/public/research.js  isolated virtual wallet and strategy studies
frontend/public/favicon.svg  logo
backend/server.py            FastAPI app, every route under /api
backend/routers/deriv.py     preserved OAuth/session and Demo APIs
backend/routers/account_display.py  authorized read-only balances/history
backend/lib/deriv_demo.py    authenticated Demo sockets, execution and order ledger
render.yaml                  Render blueprint
env.example                  configuration template (no credentials)
```

The React/TypeScript files in `frontend/src` belong to the original template and are not used: `index.html` loads `/app.js` directly.

## Environment variables (backend/.env, never commit real values)

| Name | Purpose |
|------|---------|
| `MONGO_URL`, `DB_NAME` | MongoDB (Atlas `mongodb+srv://` works); the backend needs it to start |
| `CORS_ORIGINS` | allowed browser origins, comma-separated |
| `DERIV_APP_ID` | your existing verified OAuth App ID |
| `DERIV_DEMO_TRADING_ENABLED` | `false` by default; set exactly `true` only when Demo execution deployment is approved |

## Run locally

```bash
cd backend
pip install -r requirements.txt
cp ../env.example .env   # then fill in the values privately
uvicorn server:app --port 8001 --reload
# frontend: any static server that proxies /api → :8001, e.g. the Vite dev server:
cd ../frontend && yarn install && yarn dev   # http://localhost:3000
```

Without a backend, public market data, simulation and comparison still work. Account connection and actual Demo execution require the backend. Do not put credentials in frontend environment variables.

## Deploy on Render

The existing backend is `https://deriv-edge-lab-2oux.onrender.com`. Reuse it; creating a new Blueprint instance can create a duplicate backend. The Blueprint remains a reference for the two-service configuration and explicitly selects Free compute and the tested Python version. Do not apply hosting changes until deployment is approved.

Existing Python backend settings:

| Setting | Value |
|---|---|
| Runtime / compute | Python 3 / Free |
| Root directory | `backend` |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn server:app --host 0.0.0.0 --port $PORT --workers 1` |
| Python version | `PYTHON_VERSION=3.12.14` |
| Health check | `/api/deriv/config` |

The backend's `/` returns 404 because no root route is defined. `/api/` and `/api/deriv/config` exist. The config endpoint does not access MongoDB and its `oauth_ready` flag means an App ID is configured, not that a login has been verified. The dashboard uses the backend's same-origin `/api/*` proxy. Configuration retries are bounded and run in the background when a Free backend is waking; market data does not wait for all retries.

### MongoDB Atlas authentication

Keep `MONGO_URL` exclusively in **Render → existing backend → Environment**. Keep the existing `DB_NAME` (for example `app`); `deriv_edge_lab` is the template default for a new setup. The code passes the URI to Motor/PyMongo without rewriting credentials or `authSource`; `DB_NAME` selects the application database separately from the authentication database.

If fresh logs still report `bad auth` / code 8000:

1. Open the Atlas project containing the intended cluster. Under **Security → Database Access**, confirm the database username. This is a database user, separate from the account used to sign in to Atlas. Reset that user's password only if needed. Give the app user `readWrite` on the database named by the existing `DB_NAME` so it can store status checks and the Demo order ledger and create indexes.
2. Under the cluster's **Connect → Drivers → Python**, obtain a fresh connection-string template. Fill its username/password privately. Percent-encode reserved characters in those components exactly once; do not encode the entire URI or keep placeholder brackets. Atlas SRV connections normally obtain `authSource=admin` from DNS; retain the Atlas-generated options and remove an incorrect explicit authSource override. Do not disable TLS or certificate verification.
3. In Render's backend Environment, edit **MONGO_URL** with the completed URI, without surrounding quotes or accidental whitespace. Never put it in GitHub, frontend variables, screenshots, or chat. Apply the environment update when ready for its restart/redeployment.
4. Keep the service's current outbound ranges allowed in Atlas Network Access (`74.220.48.0/24` and `74.220.56.0/24`, as supplied for this service). Recheck Render's outbound ranges if the service/region changes.
5. After the backend restarts, check fresh logs and open `/api/status`. HTTP 200 with a JSON list verifies a database read; it does not alone verify writes/index creation. Avoid resetting a working password because of an old log entry.

See [Atlas authentication troubleshooting](https://www.mongodb.com/docs/atlas/troubleshoot-connection/) and [MongoDB URI options](https://www.mongodb.com/docs/manual/reference/connection-string-options/).

### Existing dashboard as a Render Static Site

After merge/deployment approval, choose **New → Static Site** and connect this repository:

| Setting | Value |
|---|---|
| Branch | `main` after the deployment fix is merged |
| Root directory | Leave blank (repository root) |
| Build command | `mkdir -p site && cp frontend/index.html site/ && cp -r frontend/public/. site/` |
| Publish directory | `site` |
| Start command | None |
| Rewrite source | `/api/*` |
| Rewrite destination | `https://deriv-edge-lab-2oux.onrender.com/api/*` |
| Rewrite action | **Rewrite**, not Redirect |

This copies the existing HTML, CSS, JavaScript and assets. No Node server or React rebuild is required for the static dashboard. No secrets or frontend environment variables are required.

Once Render assigns the frontend HTTPS URL, set the backend's **CORS_ORIGINS** to that exact origin (no path or trailing slash). In the existing Deriv OAuth application's settings, use that origin as Website URL and register `<frontend-origin>/api/deriv/callback` as the exact Redirect URL. The frontend proxy must preserve the callback query parameters and forward POST `/api/deriv/token`. Returning through the frontend origin preserves the PKCE state stored by that browser tab. The current public-client PKCE code does not require a client secret. Credentials stay in backend memory; the browser receives a Secure, HttpOnly, SameSite=Lax session cookie and a CSRF token. Old browser-stored credentials are cleared, so reconnect after upgrading.

For acceptance, open `<frontend-origin>/api/deriv/config` and confirm JSON from the backend, then open the dashboard in desktop/mobile Chrome. Verify a real live-price status (not the labelled synthetic fallback). Test OAuth through Deriv in the same tab and confirm returned account data before considering login successful. The frontend HTTPS URL is also the Android preview/website URL; no purchased domain is required. Live Deriv, OAuth and Atlas write access must be verified after deployment, not inferred from local mock tests.

## Simulation rules

These rules describe the research simulator. Actual Demo mode uses Deriv's authenticated quotes, buys and contract-status responses; it never credits an estimated simulator payout to the account.

- Only one virtual contract is open at a time, and a new one never opens on the tick that settled the last one. This rules out duplicate entries.
- **Differs:** opens on tick T and settles on tick T+1. Profit = Deriv's live quoted payout − stake; loss = stake. Example: $50 stake → +$4.82 if it wins, −$50 if it loses.
- **Accumulator:** grows by the chosen % each tick while |Δprice / previous price| stays below Deriv's live `tick_size_barrier`. A breach loses the stake. It closes at +10% of stake (background take-profit) or at Deriv's `maximum_ticks`.
- **Multiplier:** P/L = stake × multiplier × move% − Deriv's live commission. Uses the multiplier values Deriv allows for the chosen index. Stop-out at −stake; closes at +10% of stake or after 120 ticks at market.
- Controls: Stake, Profit target, Total loss limit, Start/Pause/Stop. A contract is never opened if its full-stake loss would push the session past the loss limit. Background cap: 1,000 trades per session. A single contract's loss is always at most the stake.

Accumulator and Multiplier results are close approximations of Deriv's settlement. Nothing here predicts the next tick. Every contract type has a house edge. Not financial advice.

## Simulation integrity and regression checks

- Stop lets an open contract finish in its original session. New session stays disabled until then. Pause/Resume preserves that session; reaching a profit/loss limit while paused stops it.
- Market selection is locked while a contract is open. A disconnect or missing tick stops research and records an open position as **Unresolved / P/L unknown**, rather than inventing a settlement or silently deleting it. Settled P/L excludes unknown results and the session is labelled incomplete.
- The labelled synthetic fallback is display only. Start needs a verified live tick; generated ticks never enter research statistics or settle contracts. Duplicate, out-of-order, invalid and wrong-market ticks are rejected before they affect research.
- Maximum equity drawdown includes observed open-position P/L (including Multiplier entry commission). Zero-profit settlements are break-even, not losses. Comparison statistics use the same accounting and identify any still-open final position as unresolved. Entry rules, payouts and settlement formulas are unchanged.

From the repository root, run the deterministic tests with Node.js (no packages, tokens, backend or database needed):

```bash
node --test tests/simulation.test.cjs
```

Browser checks use Playwright and Chromium, with all Deriv sockets mocked:

```bash
node --test tests/simulation-browser.test.cjs
```

If Chromium is already installed outside Playwright's usual location, set `CHROMIUM_PATH` to its executable. These tests check software correctness, not profitability or live OAuth connectivity.

## Actual Deriv Demo contracts

Deployment requires approval. This build includes the pending cold-start/routing fixes from PR #2 so the backend and frontend can be upgraded together. Reuse the current Render Free backend and Static Site; no new services are needed.

1. Keep the existing private `MONGO_URL` and current `DB_NAME` (for example `app`). The Atlas database user needs `readWrite` on that database for `demo_orders` and `demo_account_locks`. No credentials or OTPs are written to these collections.
2. Use one Uvicorn worker (`--workers 1`). Account sessions and OAuth/PAT credentials live only in that worker's memory. A restart/expiry requires sign-in again; durable account locks still prevent a duplicate buy.
3. In Render's backend Environment, enable `DERIV_DEMO_TRADING_ENABLED=true` only as part of the approved deployment. Configure `CORS_ORIGINS=https://deriv-edge-lab-1.onrender.com`. Both are non-secret settings. Keep all passwords/tokens in Render/Atlas; never paste them into chat or GitHub. Default execution remains disabled.
4. Deploy both services after approval and reconnect through the existing verified Deriv OAuth application. The callback stays `https://deriv-edge-lab-1.onrender.com/api/deriv/callback`.
5. In the dashboard choose **Deriv Demo · actual Demo contracts**, set the product/market, stake and limits, then click **Start Demo trading**. Demo execution keeps the existing manually selected digit. Automatic digit rules are research comparisons only. Connecting an account alone never starts orders. The first live acceptance test should use the minimum supported stake in the Demo account and verify the contract ID and actual account debit/settlement in Deriv. No acceptance orders were placed by development tools.

Only active USD Demo accounts are supported by this execution build. Real accounts and `/ws/real` connections are rejected on the backend, regardless of browser settings. Research mode remains available and sends no orders.

The backend requests `subscribe: 1` proposals before buying. Differs uses the selected digit and one-tick contract. Accumulators and Multipliers retain the 10%-of-stake take-profit setting, implemented through Deriv limit orders. Multipliers are also closed after 120 observed actual ticks following the provider's entry spot; recovered gaps use Deriv tick history. Final P/L, fees, buy/sell prices and balance always come from Deriv. The research payout formulas and experimental comparison filters are unchanged. Experimental filters are simulation-only; Demo settings stay fixed for a run.

Pause/Stop prevent new entries while the existing contract continues to its Deriv settlement. Closing the browser sends no further entry signals. After refresh, an existing running session is paused rather than silently resumed. On an interrupted public feed, new entries stop while the backend continues monitoring the actual contract. Disconnect clears the browser cookie, stops entries, and monitors an already acknowledged contract until settlement.

Each buy requires a fresh account-type check, authenticated Demo tick, balance, empty portfolio, risk-budget check and atomic MongoDB account lock. A lost buy receipt is **not retried**. If the receipt is unknown and no contract ID was stored, execution stays blocked until that order is reconciled against the official Demo statement; do not clear the lock or resubmit just to make Start work. A known contract ID is recovered read-only after sign-in and its actual final result is recorded once. Provider-managed take-profit/stop-out rules remain in force if the backend disconnects; client-controlled exits can be delayed by outages.

The small-win/full-stake-loss payoff risk is unchanged. Actual Demo execution is not evidence of a profitable strategy and does not add a predictive edge.

Offline checks:

```bash
node --test --test-concurrency=1 tests/simulation.test.cjs tests/simulation-browser.test.cjs tests/demo-browser.test.cjs tests/deployment.test.cjs
cd backend
python -m pytest tests/test_demo_execution.py
```

The original backend endpoint tests still require the local test server described in `backend/tests/conftest.py`. Live Render cookie forwarding, OAuth, authenticated WebSocket connectivity and the first actual Demo order require acceptance testing after deployment; mocks cannot verify those connections.

## Virtual research update (separate review branch)

The optional Strategy comparison panel now includes **Virtual strategy and risk study**. It compares 23 references/candidates using a separate virtual balance, public quotes, explicit costs, next-tick simulated entries, and training/validation/holdout boundaries. It includes Differs, Matches, Over/Under, Rise/Fall, Touch/No Touch, Accumulators and Multipliers, plus flat/Paroli/Martingale risk comparisons. It never changes the authorised account's strategy, balance or orders.

Manual digit controls and Demo entry configuration are preserved. Automatic cold-digit strategies remain confined to the virtual comparison engine. Demo tickets use authenticated entry quotes or actual winning settlements, not public payout previews. Authorised Demo/Real account identification and timestamped balances are available in a read-only REST list; Real accounts cannot be selected for execution. The existing login still requires an active USD Demo account.

See [the complete research report and completion checklist](research/REVIEW.md) for real sampled results, sources, limitations and reproduction commands. The validation-selected strategies lost money on held-out samples; this work does **not** deliver a proven profitable bot. The new branch requires approval before merge or deployment. No new packages or services are needed.


## Research rebuild v2 (separate approval)

The rebuild retains all 23 earlier references and adds seven virtual-only alternatives. It fixes the biased random reference, premature rounding in empirical break-even, and weak payout validation. A strict research screen returns **NO TRADE** when evidence or risk constraints are not met; no fixed-strategy fallback is promoted and no research result configures Demo orders. The live/manual Demo path is unchanged.

See [the before/after report and all-strategy comparison](research/REBUILD-V2.md). The implementation/protocol were frozen before collecting 20,000 separate public evaluation ticks. None of the candidates qualified; the old selector lost an estimated $226.39 on the new test windows while the rebuilt decision abstained. This is not a claim of profitable trading. Reproduce with `node scripts/evaluate-v2.cjs`; no account or new dependencies are needed. PR #5 is the safe foundation, draft PR #6 is an unapplied execution archive, and the v2 research work is a separate review branch. Nothing should merge/deploy without approval.

## Website restoration release

See [the restoration report](research/WEBSITE-RESTORATION.md) for restored sounds, authorized account display, persistent separate virtual wallets, six educational categories, verification and limitations. Historical PR #7 results remain in [the fixed-protocol report](research/REBUILD-V2.md). The Render build still uses the existing static files and Python backend; no new service or dependency is required.
