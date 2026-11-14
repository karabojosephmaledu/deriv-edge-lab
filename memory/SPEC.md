# Deriv Edge Lab — SPEC (v4: research simulator + view-only account)

## What it is
Vanilla HTML/CSS/JS dashboard (`frontend/index.html`, `frontend/public/app.js`, `frontend/public/styles.css`,
`frontend/public/favicon.svg`; the React `frontend/src/**` is unused template code) + FastAPI backend.
Two separate areas:
1. **Research simulation**: real Deriv ticks (public WS `wss://api.derivws.com/trading/v1/options/ws/public`), VIRTUAL money,
   NEVER places Deriv contracts. app.js contains no buy/sell calls.
2. **Connected account (view-only)**: OAuth PKCE (auth.deriv.com, scope "trade account_manage") or API token (PAT +
   Deriv-App-ID) → GET /trading/v1/options/accounts → account switcher → OTP WS for the balance stream only.
   "Order execution disabled during testing" note. Owner nickname, Verified badge (= Deriv-authenticated login, not KYC),
   currency flag, Demo/Real badge.
The Simulate/Live toggle, arming dialog, daily limits and Matches were removed in v4.

## Simulation engine (app.js: openContract/stepContract, shared by the live session and the comparison tool)
- One open virtual contract at a time; a new one never opens on the tick that settled one (no duplicates).
- Differs: opens on tick T, settles on T+1; win if last digit ≠ chosen digit; profit = stake × live Deriv payout ratio − stake
  (quoted per digit at the current stake); loss = stake. Verified: $50 → payout $54.82 → +$4.82 / −$50.
- Accumulator: growth 1–5%; knock-out if |Δp/prev| ≥ live `tick_size_barrier` (R_100 3% = 0.0537%); closes at the
  per-contract profit target or at `maximum_ticks`; loss = stake.
- Multiplier ×40–400 Up/Down: pnl = stake×m×move% − live commission; stop-out at −stake; closes at the target or after 600 ticks.
- Ticket (data-testid contract-ticket): stake, payout if win, profit if win, max loss, note — shown before each contract.
- Session controls: virtual stake, profit target, max session loss, max trades, Start/Pause(→Resume)/Stop(→New session).
  Limits only stop NEW contracts; Stop lets an open contract settle. Changing the market voids an open contract (not counted).
- Optional entry filters (per product) and Differs auto-digit (least frequent digit in the last 100 ticks), labelled as hypotheses.
- Digit explanation (digit-explain): meaning of the selection + frequency/last-seen history, with an explicit no-prediction note.
- History: up to 500 rows in a scroll box about 10 rows tall (history-scroll), with an individual P/L column and a separate cumulative "Session" column.
- Last contract box (last-trade) is separate from the session totals (wins/losses/win rate/net/avg win/avg loss/max drawdown).
- Comparison (lab-run-btn): ticks_history 1000 → 8 rows (Differs fixed/random/auto walk-forward/filtered, Accu ±filter,
  Mult ±filter); auto uses only past ticks (out-of-sample).

## Backend (all under /api)
- `GET /deriv/config` {app_id, public_ws_url, api_base, oauth_ready, oauth_authorize_url}; `GET /deriv/callback`;
  `POST /deriv/token` {code, code_verifier 43–128, redirect_uri ending /api/deriv/callback}: 422 bad body, 400 on Deriv error.
- Env: MONGO_URL, DB_NAME, CORS_ORIGINS, DERIV_APP_ID. No AI/Emergent dependencies (v5 removed the AI coach, routers/ai.py, lib/owner.py, emergentintegrations).
  `env.example` / `backend/.env.example` hold names only (.gitignore exception added). render.yaml + README for deploy.

## Not testable without the user's Deriv login
OAuth completion, account list/switching, balance, owner nickname.

## v5 changes (cleanup)
- Layout restored to original card structure; long explanations removed. Strategy comparison is a collapsible <details> (lab-card).
- Visible sim controls only: stake-input, session-target-input, session-maxloss-input, start/pause/stop. Background: per-contract
  TP = 10% of stake (accu/mult), MAX_TRADES=1000, loss limit pre-check (never opens a contract whose loss would breach the limit).
- Multiplier chips are generated per symbol from Deriv's allowed values (MULTS in app.js); MULT_MAX_TICKS=120.
- bindEvents uses a null-safe on() helper (missing element → console.warn, no crash).
- Account switch falls back to the previous account on failure; nav account button scrolls to the account card when connected.
- History: 6 columns (#, Time, Contract, Stake, P/L, Result), row tooltip has market/detail/session total.

## v6 (final fixes)
- OAuth root cause: Deriv returns "redirect_uri does not match any pre-registered redirect urls" for every tested URL with the
  configured DERIV_APP_ID. The user must register `<origin>/api/deriv/callback` in developers.deriv.com. The connect dialog shows the exact URL (oauth-redirect-url).
- History scroll box is fixed at 236px (about 5 rows); the card height doesn't grow.
