# Personal original-strategy Deriv worker

The existing website and production hosting have not been replaced or deployed by this branch. The optional runtime uses the recovered EazyXPro analyzer with native Node 24 and the existing Python backend. There is no new subscription, platform account, frontend secret or Node package install.

## Backend configuration after review

Keep existing `MONGO_URL`, `DB_NAME`, `DERIV_APP_ID`, `APP_URL` and `CORS_ORIGINS` settings. Keep the current frontend rewrite `/api/*` → `https://deriv-edge-lab-2oux.onrender.com/api/*` and registered OAuth redirect `https://deriv-edge-lab-1.onrender.com/api/deriv/callback`. No new callback/app ID is required by this code.

Add AI credentials only in **Render → Python backend service → Environment**, never the Static Site or GitHub. Six independent slots are supported: `CHART_AI_SLOT_1_PROVIDER`, `CHART_AI_SLOT_1_API_KEY`, optional `CHART_AI_SLOT_1_MODEL`, repeated through slot 6. Supported protocol values are `openai`, `openrouter`, `gemini`. One configured working slot is sufficient; different keys may use the same provider. Blank MODEL attempts discovery; a successful randomized image-reading probe is required even for a manually configured model. Discovery, quota, image and truncated-response failures fall back to available candidates/slots. The whole analysis has a three-minute bound, so slow failures can exhaust the bound before every slot is tried. Auto-discovery is not a guarantee of model access, context capacity or low cost. Full-source chart analysis uses provider credits.

Feature flags (all automatic execution remains off unless explicitly enabled):

| Variable | Purpose |
| --- | --- |
| `CHART_AUTOTRADING_ENABLED` | Exposes the original-chart automatic UI and permits this execution path. Default false. |
| `DERIV_DEMO_TRADING_ENABLED` | Existing Demo execution flag, also required for new Demo sessions. |
| `DERIV_LIVE_TRADING_ENABLED` | New independent Live execution flag. Default false; the selected authorized Live account and per-session checkbox are also required. |

Keys authorize AI analysis; existing OAuth authorizes the selected Deriv account and must have the provider-required permissions. Never use a key from conversation history. No API key, OAuth token, OTP or cookie value is passed to AI prompts or stored in the order ledger. Ledger records include account IDs, configurations, chart interpretation and actual contract results; keep MongoDB private and access-controlled as before.

## Runtime / Render preparation

The existing Python-only Render runtime does not guarantee Node 24. `Dockerfile.chartscanner` supplies Python 3.12, Node 24 and Pillow, keeping uvicorn bound to `$PORT`. It was built and HTTP-smoke-tested locally. Build from the repository root with this Dockerfile, **not** a `backend/`-only Docker context, so the worker is included. The default Docker start command is provided. A managed review environment required a build-only CA bundle; the optional BuildKit `build_ca` secret supports that without disabling TLS or embedding a certificate. Ordinary Render builds do not need this secret.

No Render service, paid plan, build setting, secret or feature flag was changed. Changing the current Python service to this runtime is a separate hosting action; preserve its URL, environment and frontend rewrite. Do not deploy the frontend alone and enable it against an old backend. Keep automatic and Live flags off until the matching backend is installed, configuration is verified and the Demo flow has been reviewed.

The frontend Static Site still uses its existing build command:

```sh
mkdir -p site && cp frontend/index.html site/ && cp -r frontend/public/. site/
```

Publish `site`; no frontend AI environment variables. `/api/deriv/chart/config` reports feature/configuration presence, not authenticated account connectivity. `/api/deriv/chart/status` requires the existing authorized cookie.

Render Free can sleep/restart; account sessions expire and server-side tokens are intentionally not persisted. This is **not** a verified always-on three-month bot. Expiry/logout/connection errors stop new entries, and restarts never automatically resume entries. Provider exits remain attached to acknowledged contracts. Monitoring recovery requires reconnecting the same authorized account. Real provider, MongoDB and AI functionality must be checked before enabling a session; no current test proves profitable results.

## Tests and evidence

Full available existing/new run: 126 backend tests + 215 JavaScript/browser tests passed. Final targeted checks add two durable-intent cancellation cases, three actual-scanner integration cases and malformed-provider-output fallback, for **347 distinct passing tests** in the final tree (128 Python + 219 JavaScript/browser). Targeted final runs also repeat the changed browser and scanner suites. TypeScript checking of the native worker and its imports passed. Docker build and offline worker/HTTP startup smoke checks passed with execution disabled. Provider/AI responses in automated tests are controlled data; no test places authenticated broker orders.

```sh
node --test tests/*.test.cjs chartscanner/tests/*.test.mjs
PYTHONPATH=backend BACKEND_URL=http://127.0.0.1:8014 python -m pytest -q backend/tests
docker build -f Dockerfile.chartscanner -t deriv-chartscanner-review .
```

The generated config/callback/token HTTP tests require a local uvicorn backend at `BACKEND_URL`; the config fixture expects the repository's registered public App ID. Set local-only MongoDB test values and that public App ID, never production credentials, when reproducing. The unit/order/account tests use in-memory controlled collections. Preserve `backend/pytest.ini`'s two-worker settings. No benchmark performance was fabricated or inferred from source PDF success claims.
