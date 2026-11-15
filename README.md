# Deriv Edge Lab

A research dashboard for Deriv Volatility indices:

- **Research simulation:** real Deriv ticks with **virtual money** for Digit Differs, Accumulators and Multipliers. No Deriv contracts are placed.
- **Connected account (view-only):** Login with Deriv (OAuth + PKCE) or an API token. Shows the real Demo/Real balance and lets you switch accounts. Order execution is disabled; the code contains no buy/sell calls.
- **Strategy comparison (optional, collapsible):** replays the last 1,000 real ticks through each strategy, including a walk-forward (out-of-sample) test of the auto-digit rule against random digits.
- **No AI services:** all analysis is plain math/statistics in `app.js`. No paid API keys or Emergent credits are needed.

## Structure

```
frontend/index.html          markup (the app)
frontend/public/styles.css   styling
frontend/public/app.js       all logic (vanilla JS, no build step)
frontend/public/favicon.svg  logo
backend/server.py            FastAPI app, every route under /api
backend/routers/deriv.py     /api/deriv/config, /callback, /token (OAuth code exchange)
render.yaml                  Render blueprint
env.example                  configuration template (no credentials)
```

The React/TypeScript files in `frontend/src` belong to the original template and are not used: `index.html` loads `/app.js` directly.

## Environment variables (backend/.env, never commit real values)

| Name | Purpose |
|------|---------|
| `MONGO_URL`, `DB_NAME` | MongoDB (Atlas `mongodb+srv://` works); the backend needs it to start |
| `CORS_ORIGINS` | allowed browser origins, comma-separated |
| `DERIV_APP_ID` | your App ID from developers.deriv.com → Apps |

## Run locally

```bash
cd backend
pip install -r requirements.txt
cp ../env.example .env   # then fill in the values privately
uvicorn server:app --port 8001 --reload
# frontend: any static server that proxies /api → :8001, e.g. the Vite dev server:
cd ../frontend && yarn install && yarn dev   # http://localhost:3000
```

With no backend at all (for example on CodePen), the dashboard still runs. Live market data, simulation, comparison and API-token connect all work. Login with Deriv needs the backend.

## Deploy on Render

The existing backend is `https://deriv-edge-lab-2oux.onrender.com`. Reuse it; creating a new Blueprint instance can create a duplicate backend. The Blueprint remains a reference for the two-service configuration and explicitly selects Free compute and the tested Python version. Do not apply hosting changes until deployment is approved.

Existing Python backend settings:

| Setting | Value |
|---|---|
| Runtime / compute | Python 3 / Free |
| Root directory | `backend` |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn server:app --host 0.0.0.0 --port $PORT` |
| Python version | `PYTHON_VERSION=3.12.14` |
| Health check | `/api/deriv/config` |

The backend's `/` returns 404 because no root route is defined. `/api/` and `/api/deriv/config` exist. The config endpoint does not access MongoDB and its `oauth_ready` flag means an App ID is configured, not that a login has been verified. The dashboard uses the backend's same-origin `/api/*` proxy. Configuration retries are bounded and run in the background when a Free backend is waking; market data does not wait for all retries.

### MongoDB Atlas authentication

Keep `MONGO_URL` exclusively in **Render → existing backend → Environment**. Set `DB_NAME=deriv_edge_lab`. The code passes the URI to Motor/PyMongo without rewriting credentials or `authSource`; `DB_NAME` selects the application database separately from the authentication database.

If fresh logs still report `bad auth` / code 8000:

1. Open the Atlas project containing the intended cluster. Under **Security → Database Access**, confirm the database username. This is a database user, separate from the account used to sign in to Atlas. Reset that user's password only if needed. Give the app user `readWrite` on `deriv_edge_lab` so it can read/write status checks and create their index.
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

Once Render assigns the frontend HTTPS URL, set the backend's **CORS_ORIGINS** to that exact origin (no path or trailing slash). In the existing Deriv OAuth application's settings, use that origin as Website URL and register `<frontend-origin>/api/deriv/callback` as the exact Redirect URL. The frontend proxy must preserve the callback query parameters and forward POST `/api/deriv/token`. Returning through the frontend origin preserves the PKCE state stored by that browser tab. The current PKCE code does not require a client secret.

For acceptance, open `<frontend-origin>/api/deriv/config` and confirm JSON from the backend, then open the dashboard in desktop/mobile Chrome. Verify a real live-price status (not the labelled synthetic fallback). Test OAuth through Deriv in the same tab and confirm returned account data before considering login successful. The frontend HTTPS URL is also the Android preview/website URL; no purchased domain is required. Live Deriv, OAuth and Atlas write access must be verified after deployment, not inferred from local mock tests.

## Simulation rules

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
