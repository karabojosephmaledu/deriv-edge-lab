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
env.example                  variable NAMES only (backend/.env.example is the same file)
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
cp .env.example .env   # then fill in the values
uvicorn server:app --port 8001 --reload
# frontend: any static server that proxies /api → :8001, e.g. the Vite dev server:
cd ../frontend && yarn install && yarn dev   # http://localhost:3000
```

With no backend at all (for example on CodePen), the dashboard still runs. Live market data, simulation, comparison and API-token connect all work. Login with Deriv needs the backend.

## Deploy on Render

1. Push the repo to GitHub (keep your existing backup; push to a new branch if you're unsure).
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` creates the API service and the static site.
3. Create a free MongoDB Atlas cluster and set `MONGO_URL`, `CORS_ORIGINS` (your static-site URL), and `DERIV_APP_ID` on the API service.
4. If Render names the API service differently, update the rewrite destination in `render.yaml`.
5. In developers.deriv.com → your app, add the redirect URL `https://<your-static-site>.onrender.com/api/deriv/callback`.

## Simulation rules

- Only one virtual contract is open at a time, and a new one never opens on the tick that settled the last one. This rules out duplicate entries.
- **Differs:** opens on tick T and settles on tick T+1. Profit = Deriv's live quoted payout − stake; loss = stake. Example: $50 stake → +$4.82 if it wins, −$50 if it loses.
- **Accumulator:** grows by the chosen % each tick while |Δprice / previous price| stays below Deriv's live `tick_size_barrier`. A breach loses the stake. It closes at +10% of stake (background take-profit) or at Deriv's `maximum_ticks`.
- **Multiplier:** P/L = stake × multiplier × move% − Deriv's live commission. Uses the multiplier values Deriv allows for the chosen index. Stop-out at −stake; closes at +10% of stake or after 120 ticks at market.
- Controls: Stake, Profit target, Total loss limit, Start/Pause/Stop. A contract is never opened if its full-stake loss would push the session past the loss limit. Background cap: 1,000 trades per session. A single contract's loss is always at most the stake.

Accumulator and Multiplier results are close approximations of Deriv's settlement. Nothing here predicts the next tick. Every contract type has a house edge. Not financial advice.
