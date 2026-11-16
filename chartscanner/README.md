# Personal original-strategy Deriv worker

The optional runtime uses the recovered EazyXPro analyzer with native Node 24 and the existing Python backend. PR #14 was merged with execution disabled. The follow-up packaging fix keeps the worker inside `backend/chartscanner/`, so Render's existing Python service with `rootDir: backend` can include it. There is no new subscription, service URL, frontend secret or Node package install.

## Backend configuration after review

Keep existing `MONGO_URL`, `DB_NAME`, `DERIV_APP_ID`, `APP_URL` and `CORS_ORIGINS` settings. Keep the current frontend rewrite `/api/*` → `https://deriv-edge-lab-2oux.onrender.com/api/*` and registered OAuth redirect `https://deriv-edge-lab-1.onrender.com/api/deriv/callback`. No new callback/app ID is required by this code.

Add AI credentials only in **Render → Python backend service → Environment**, never the Static Site or GitHub. Six independent slots are supported: `CHART_AI_SLOT_1_PROVIDER`, `CHART_AI_SLOT_1_API_KEY`, optional `CHART_AI_SLOT_1_MODEL`, repeated through slot 6. Supported protocol values are `openai`, `openrouter`, `gemini`. One configured working slot is sufficient; different keys may use the same provider. Blank MODEL attempts discovery, preferring fast image-capable variants; a successful randomized image-reading probe is required even for a manually configured model. The probe has a 1,024-token allowance so reasoning can finish before its final short image answer. Discovery, quota, image and truncated-response failures fall back to available candidates/slots. The analysis process has a **45-second scalping budget**, so slow failures can exhaust it before every slot is tried. Auto-discovery is not a guarantee of model access, context capacity, speed or low cost. Full-source analysis once per closed minute uses more provider credits than the former 15-minute schedule.

The session panel distinguishes loading, analysing, waiting, quote/acknowledgement checks, acknowledged contracts, pause/stop and recovery. It shows last analysis, next check and last server status. Loss of polling shows unknown activity rather than claiming a running server has stopped. Typed provider errors survive the worker bridge as static categories (credentials, credits, quota/rate limit, model availability, request rejection, output/JSON/image failure or timeout); raw response bodies, keys and OTPs are never returned. Unknown exception strings are not echoed. The user's original generic failure could not identify its cause; public 1HZ75V/R_100 candle and chart-render checks passed, but that does not verify the user's authenticated AI or broker requests.

Visible trade history switches between this bot session's actual settlements and the selected account's existing read-only Deriv history, including external trades. Account history never changes session P/L. Empty/unavailable history is labelled explicitly. Actual session outcomes reuse the original WIN/LOSS sound generator once, with no replay on reload. No order is placed simply to satisfy a one-minute timer; original evidence and authenticated quote checks remain required.

Feature flags (all automatic execution remains off unless explicitly enabled):

| Variable | Purpose |
| --- | --- |
| `CHART_AUTOTRADING_ENABLED` | Exposes the original-chart automatic UI and permits this execution path. Default false. |
| `DERIV_DEMO_TRADING_ENABLED` | Existing Demo execution flag, also required for new Demo sessions. |
| `DERIV_LIVE_TRADING_ENABLED` | New independent Live execution flag. Default false; the selected authorized Live account and per-session checkbox are also required. |

Keys authorize AI analysis; existing OAuth authorizes the selected Deriv account and must have the provider-required permissions. Never use a key from conversation history. No API key, OAuth token, OTP or cookie value is passed to AI prompts or stored in the order ledger. Ledger records include account IDs, configurations, chart interpretation and actual contract results; keep MongoDB private and access-controlled as before.

## Runtime / Render preparation

Render excludes files outside a service's root directory. The original repository-root scanner layout therefore did not fit the existing backend-root Python deployment. The worker and all runtime modules now live under `backend/chartscanner/`. A backend-only isolated-copy test imports it without repository siblings. Keep the existing Root Directory `backend`, build `pip install -r requirements.txt`, and start `uvicorn server:app --host 0.0.0.0 --port $PORT --workers 1`. `backend/.node-version` pins Node 24.22.1; the worker's package also bounds its supported major to 24. The config endpoint now reports the actual `node_version`, strict Node 24 readiness and `worker_available` instead of assuming any executable named node is adequate. If Render has a conflicting `NODE_VERSION` environment override, update that setting to `24.22.1`.

The Dockerfile remains an optional verified alternative, supplying Python 3.12 and Node 24 while keeping uvicorn bound to `$PORT`. It copies the same bundled backend and does not require a second scanner directory. A managed Docker review build used an optional build-only CA bundle without disabling TLS. Switching Render to Docker is not required for the current native Python service. Preserve its URL, environment and frontend rewrite. Live stays disabled; enabling Demo remains an explicit environment change after runtime checks. No saved secret values were read.

The frontend Static Site still uses its existing build command:

```sh
mkdir -p site && cp frontend/index.html site/ && cp -r frontend/public/. site/
```

Publish `site`; no frontend AI environment variables. `/api/deriv/chart/config` reports feature/configuration presence, not authenticated account connectivity. `/api/deriv/chart/status` requires the existing authorized cookie.

Render Free can sleep/restart; account sessions expire and server-side tokens are intentionally not persisted. This is **not** a verified always-on three-month bot. Expiry/logout/connection errors stop new entries, and restarts never automatically resume entries. Provider exits remain attached to acknowledged contracts. Monitoring recovery requires reconnecting the same authorized account. Real provider, MongoDB and AI functionality must be checked before enabling a session; no current test proves profitable results.

## Tests and evidence

PR #14 verification covered **347 distinct passing tests** (128 Python + 219 JavaScript/browser), using the full available suite followed by targeted final checks. The Render packaging follow-up passed **106 targeted tests** (57 Python + 49 JavaScript/browser), including six new Node-version/backend-only packaging cases and a missing-worker browser case. Native worker TypeScript checking passed again. Original strategy and provider source modules are unchanged by the move. The earlier Docker build and offline worker/HTTP startup smoke checks passed with execution disabled. Provider/AI responses in automated tests are controlled data; no test places authenticated broker orders.

The M1 status/history update covers **369 distinct passing tests** (141 Python + 228 JavaScript/browser) using the full suite and final targeted reruns. The full JavaScript run caught the word `mini` inside `gemini` being mistaken for a fast-model tag; that ranking expression was corrected and all 38 scanner/provider tests reran successfully. The final M1 quote-expiry case passed with all 64 automatic-runtime tests. Native TypeScript checking passed. Read-only public 1HZ75V checks verified all six timeframes, including M1/M5, and chart rendering. No private provider key, authenticated AI response, or actual Demo order was available for the developer to verify; those remain checks in the user's authorized session. The code no longer hides their failure behind a generic stopped message.

```sh
node --test tests/*.test.cjs chartscanner/tests/*.test.mjs
PYTHONPATH=backend BACKEND_URL=http://127.0.0.1:8014 python -m pytest -q backend/tests
docker build -f Dockerfile.chartscanner -t deriv-chartscanner-review .
```

The generated config/callback/token HTTP tests require a local uvicorn backend at `BACKEND_URL`; the config fixture expects the repository's registered public App ID. Set local-only MongoDB test values and that public App ID, never production credentials, when reproducing. The unit/order/account tests use in-memory controlled collections. Preserve `backend/pytest.ini`'s two-worker settings. No benchmark performance was fabricated or inferred from source PDF success claims.
