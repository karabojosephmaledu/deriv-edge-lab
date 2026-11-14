# Deriv Edge Lab

A research dashboard for Deriv Volatility indices:

- **Research simulation:** real Deriv ticks with **virtual money** for Digit Differs, Accumulators and Multipliers. No Deriv contracts are placed.
- **Connected account (view-only):** Login with Deriv (OAuth + PKCE) or an API token. Shows the real Demo/Real balance and lets you switch accounts. Order execution is disabled; the code contains no buy/sell calls.
- **Strategy comparison:** replays the last 1,000 real ticks through each strategy, including a walk-forward (out-of-sample) test of the auto-digit rule against random digits.
- **AI coach (optional, owner-only):** runs only when you click it. It is hidden unless the server confirms through Deriv that you are `OWNER_NICKNAME` and `EMERGENT_LLM_KEY` is set.

## Structure

```
frontend/index.html          markup (the app)
frontend/public/styles.css   styling
frontend/public/app.js       all logic (vanilla JS, no build step)
frontend/public/favicon.svg  logo
backend/server.py            FastAPI app, every route under /api
backend/routers/deriv.py     /api/deriv/config, /callback, /token (OAuth code exchange)
backend/routers/ai.py        /api/ai/* (owner-only, optional)
backend/lib/owner.py         owner verification via Deriv /account/v1/nickname
render.yaml                  Render blueprint
env.example                  variable NAMES only (backend/.env.example is the same file)
```

The React/TypeScript files in `frontend/src` belong to the original template and are not used: `index.html` loads `/app.js` directly.

## Environment variables (backend/.env, never commit real values)

| Name | Purpose |
|------|---------|
| `MONGO_URL`, `DB_NAME` | MongoDB, used for the AI chat history and the pinned owner identity |
| `CORS_ORIGINS` | allowed browser origins, comma-separated |
| `DERIV_APP_ID` | your App ID from developers.deriv.com → Apps |
| `OWNER_NICKNAME` | your Deriv nickname (for example `client_xxxx`); unlocks the AI coach |
| `EMERGENT_LLM_KEY` | optional; leave empty and the AI coach stays off |

## Run locally

```bash
cd backend
pip install -r requirements.txt --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/
cp .env.example .env   # then fill in the values
uvicorn server:app --port 8001 --reload
# frontend: any static server that proxies /api → :8001, e.g. the Vite dev server:
cd ../frontend && yarn install && yarn dev   # http://localhost:3000
```

With no backend at all (for example on CodePen), the dashboard still runs. Live market data, simulation, comparison and API-token connect all work. Login with Deriv and the AI coach need the backend.

## Deploy on Render

1. Push the repo to GitHub (keep your existing backup; push to a new branch if you're unsure).
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` creates the API service and the static site.
3. Create a free MongoDB Atlas cluster and set `MONGO_URL`, `CORS_ORIGINS` (your static-site URL), `DERIV_APP_ID`, `OWNER_NICKNAME`, and optionally `EMERGENT_LLM_KEY` on the API service.
4. If Render names the API service differently, update the rewrite destination in `render.yaml`.
5. In developers.deriv.com → your app, add the redirect URL `https://<your-static-site>.onrender.com/api/deriv/callback`.

## Simulation rules

- Only one virtual contract is open at a time, and a new one never opens on the tick that settled the last one. This rules out duplicate entries.
- **Differs:** opens on tick T and settles on tick T+1. Profit = Deriv's live quoted payout − stake; loss = stake. Example: $50 stake → +$4.82 if it wins, −$50 if it loses.
- **Accumulator:** grows by the chosen % each tick while |Δprice / previous price| stays below Deriv's live `tick_size_barrier`. A breach loses the stake. It closes at the profit target or at Deriv's `maximum_ticks`.
- **Multiplier:** P/L = stake × multiplier × move% − Deriv's live commission. Stop-out at −stake; closes at the profit target or after 600 ticks.
- Session limits (profit target, maximum session loss, maximum trades) only stop new contracts. They never change a single contract's loss, which is always at most the stake.

Accumulator and Multiplier results are close approximations of Deriv's settlement. Nothing here predicts the next tick. Every contract type has a house edge. Not financial advice.
