# Deriv Edge Lab — SPEC

## What it is
Single-page **vanilla HTML/CSS/JS** dashboard (no React/TS/build step) simulating Deriv
digit Matches/Differs trades against live Volatility Index ticks. It NEVER places real
trades — no `buy`/`sell` call is ever constructed (app.js even refuses such payloads in
`request()`).

## Files that ARE the app (delivered to the user as three code sections)
- `frontend/index.html` — markup (Vite serves it at `/`)
- `frontend/public/styles.css` — all styling
- `frontend/public/app.js` — all application logic
- The React app in `frontend/src/**` is template dead code — intentionally orphaned (not referenced by index.html).

## Backend (FastAPI, `backend/routers/deriv.py`, mounted on api_router under /api)
- `GET /api/deriv/config` → `{app_id, ws_url, oauth_ready, oauth_url}` — public config only, no secrets.
  - `app_id` from env `DERIV_APP_ID` (default `1089`, Deriv's public test app).
  - `oauth_ready` true only when a custom registered app_id is configured.
- `GET /api/deriv/callback` → OAuth redirect target. Deriv returns tokens in the URL
  fragment (`#acct1=..&token1=..&cur1=..`) which browsers never send to servers, so this
  route returns HTML that forwards the fragment to `/` client-side. Stateless; no logging.
- No other endpoints. No DB collections (mongo unused).

## Connection / auth (token stays client-side)
- Browser connects DIRECTLY to `wss://ws.derivws.com/websockets/v3?app_id=<app_id>`.
- **OAuth "Login with Deriv"** (primary, chosen by user): active once `DERIV_APP_ID` is set to
  the user's registered app id (registered at api.deriv.com with redirect `<origin>/api/deriv/callback`).
  Flow: oauth.deriv.com → /api/deriv/callback#fragment → `/` → app.js parses `acctN/tokenN/curN`,
  prefers the Demo (VRTC*) account, stores token in sessionStorage (`del.token`), clears the URL.
- **Demo API token fallback** (same dialog): works immediately with app_id 1089 — user pastes a
  Read-scope Demo token from app.deriv.com/account/api-token.
- After `authorize`: `balance` subscribe → account card shows balance/currency/loginid +
  Demo/Real badge (VRTC* or is_virtual ⇒ Demo). Disconnect sends `logout` + `forget_all balance`
  and clears the token. `InvalidToken` clears token + reopens the dialog.
- **No credentials ever reach our backend.** No server-side accounts, sessions, or storage.

## Deriv WS usage
- One socket, unique integer `req_id` per request, ping every 30s, exponential backoff + jitter reconnect.
- Ticks: `{ticks:<symbol>, subscribe:1}`; symbol switch sends `forget_all:"ticks"` first.
- Last digit = last char of quote formatted to `tick.pip_size` decimals.
- Live payout: `{proposal:1, basis:"stake", contract_type:"DIGITMATCH"/"DIGITDIFF", duration:1,
  duration_unit:"t", underlying_symbol:<symbol>, barrier:"<digit>", subscribe:1}` — a quote only,
  never an order. multiplier = payout/ask_price (Number()-normalized; may be strings).
  Fallback multipliers 8.70× matches / 1.09× differs when offline/rate-limited.
- Markets: R_10/25/50/75/100 + 1HZ10V/25V/50V/75V/100V.

## Simulation
- While running: one virtual trade per incoming tick — win if last digit == chosen digit
  (Matches) or != (Differs). pnl = stake×(multiplier−1) on win, −stake on loss.
- Session stats (wins/losses/win-rate/net P/L/streak), 60-row history, 100-tick digit frequency.
- Persistence: settings → localStorage (`del.settings`); token → sessionStorage (`del.token`);
  stats/history session-only. Reset button clears stats/history.

## data-testids (kebab-case)
app-header, simulation-badge, connection-status, connect-button-nav, account-card, connect-button,
disconnect-button, balance-value, balance-currency, account-type, account-loginid,
market-telemetry-card, symbol-select, current-quote, tick-trail, strategy-card, trade-type-toggle,
trade-type-matches, trade-type-differs, trade-type-description, stake-input, stake-chip-{1,5,10,25,50,100},
payout-info, digit-matrix-card, digit-button-0..9, start-simulation-btn, stop-simulation-btn,
running-indicator, session-metrics-card, stat-wins, stat-losses, stat-win-rate, stat-pnl, stat-trades,
stat-streak, reset-stats-btn, result-announcer, trade-history-card, trade-history-table,
trade-history-body, trade-history-empty, digit-frequency-card, digit-frequency, disclaimer,
deriv-account-modal, oauth-connect-button, token-input, token-connect-button, connect-cancel-button,
connect-error, toast-container.

## Known deviations from the literal request
- User picked OAuth-only connect; a Demo API-token fallback is included in the same dialog
  because OAuth is inert until their own Deriv app_id is registered (1089 cannot redirect).
- User supplied website/redirect URLs on `agreeablemint4.chatgpt.site` — the callback route is
  domain-agnostic (relative forward), but their Deriv app registration must use the redirect URL
  of whichever domain actually serves this app: `https://deriv-edge-lab--3mg3a37k.preview.emergentagent.com/api/deriv/callback`.

## Synthetic demo feed (verified in-pod)
Deriv's edge (Cloudflare) rejects this pod's datacenter IP with HTTP 520 on `ws.derivws.com`
(even plain HTTPS GET → 520), so LIVE ticks cannot stream from inside the preview sandbox.
After 3 failed WS attempts the app starts a **clearly-labeled synthetic demo feed**
(status pill "Demo feed · <SYM>", quote meta "synthetic demo feed", 2s/1s cadence per symbol).
Live data resumes automatically on the first successful WS connection (onopen stops the feed).
From the user's own network the real Deriv stream should work normally.
