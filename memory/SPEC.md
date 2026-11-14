# Deriv Edge Lab — SPEC (v2, new Deriv API platform)

## What it is
Single-page **vanilla HTML/CSS/JS** Deriv digit bot. Two modes:
- **Simulate** — every tick scored virtually; nothing sent to Deriv.
- **Live trade** — REAL 1-tick DIGITMATCH/DIGITDIFF contracts bought on the user-selected account.
  Demo account = virtual funds. Real-money account requires a red "arm" dialog (checkbox) every session.
  Switching account / disconnecting drops back to Simulate. Max 2 unsettled live contracts at once.

## Files that ARE the app (delivered to user as 3 code sections)
- `frontend/index.html`, `frontend/public/styles.css`, `frontend/public/app.js`, `frontend/public/favicon.svg` (logo)
- React `frontend/src/**` is unused template code (index.html does not load it).

## Deriv platform (developers.deriv.com — NEW API)
- Public market WS (no auth, reachable from pod): `wss://api.derivws.com/trading/v1/options/ws/public`
  → ticks + proposal quotes for ALL digits 0–9 (per-digit payout ticker on the digit buttons).
- OAuth2 Authorization Code + PKCE: `https://auth.deriv.com/oauth2/auth` (client_id = App ID, scope=trade,
  redirect_uri = `<origin>/api/deriv/callback`). Token exchange via backend (auth.deriv.com has no CORS).
- Accounts: `GET https://api.derivws.com/trading/v1/options/accounts` (Bearer; PAT also needs `Deriv-App-ID`).
- Trading: `POST /trading/v1/options/accounts/{id}/otp` → `data.url` → trade WS: `balance` subscribe,
  `buy` ("1" + parameters, underlying_symbol), `proposal_open_contract` subscribe → settle on `is_sold`.
- App ID: env `DERIV_APP_ID="34XxijT4LuhpHEsZVPfoc"` (user's registered "Edge5" app, scopes Trade/Account mgmt/App insights).
  User must ADD redirect URL `https://deriv-edge-lab--3mg3a37k.preview.emergentagent.com/api/deriv/callback`
  in their Deriv app (currently only their chatgpt.site URL is registered) — otherwise auth.deriv.com rejects redirect.

## Backend (`backend/routers/deriv.py`, on api_router under /api)
- `GET /api/deriv/config` → `{app_id, public_ws_url, api_base, oauth_ready, oauth_authorize_url}` (no secrets)
- `GET /api/deriv/callback` → HTML moving `?code&state` into `/#code=..&state=..`
- `POST /api/deriv/token` `{code, code_verifier(43–128), redirect_uri(*/api/deriv/callback)}` → `{access_token, expires_in}`;
  400 with Deriv's error on bad code; 422 on invalid body. Stateless, nothing stored/logged.

## Client storage
- sessionStorage: `del.cred` {token, kind oauth|pat, expiresAt}, `del.activeAccount`, `del.pkce` {verifier,state}
- localStorage: `del.settings` (symbol/type/digit/stake/smartEntry/tp/sl), `del.appid` override

## Features
Live ticks, last-10 strip, 100-tick frequency, Matches/Differs, digits 0–9 with live payout each, fixed stake + chips,
take-profit / stop-loss auto stop, smart-entry pacing filter (NOT an edge), big ×multiplier win/loss flash,
stats (wins/losses/win rate/net P/L/streak), history (Sim/Live column), account switcher (Demo/Real), labeled
synthetic demo feed only if public WS unreachable 3×.

## Honest limits
No strategy changes digit odds; house edge is fixed by Deriv's payouts. Multipliers shown are Deriv's real payouts
(~8.9× Matches, ~1.09× Differs) — fake x10/x50 values are intentionally NOT shown.

## No server-side accounts / login. See memory/test_credentials.md.
