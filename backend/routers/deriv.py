"""Deriv integration endpoints.

The browser talks to Deriv's public WebSocket API directly; this backend only
publishes PUBLIC configuration (app_id / ws url / OAuth readiness) and serves
the OAuth redirect path.

OAuth returns tokens in the URL fragment (#acct1=...&token1=...), which
browsers never send to servers — so the callback returns a tiny HTML page
that forwards the fragment to the app root. No token ever reaches, or is
stored by, this backend. There are no secrets here: app_id is public.
"""

import os
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

router = APIRouter()

TEST_APP_ID = "1089"
DEFAULT_WS_URL = "wss://ws.derivws.com/websockets/v3"
OAUTH_AUTHORIZE_URL = "https://oauth.deriv.com/oauth2/authorize"


class DerivConfig(BaseModel):
    app_id: str
    ws_url: str
    oauth_ready: bool
    oauth_url: Optional[str] = None


@router.get("/deriv/config", response_model=DerivConfig)
async def deriv_config() -> DerivConfig:
    """Public configuration for the browser app. Contains no secrets."""
    app_id = (os.environ.get("DERIV_APP_ID", "") or "").strip() or TEST_APP_ID
    ws_url = (os.environ.get("DERIV_WS_URL", "") or "").strip() or DEFAULT_WS_URL
    # The public test app_id (1089) cannot redirect to a custom URL — the
    # OAuth button needs the user's own registered app_id from api.deriv.com.
    oauth_ready = app_id != TEST_APP_ID
    oauth_url = (
        f"{OAUTH_AUTHORIZE_URL}?app_id={app_id}&l=EN&brand=deriv" if oauth_ready else None
    )
    return DerivConfig(app_id=app_id, ws_url=ws_url, oauth_ready=oauth_ready, oauth_url=oauth_url)


@router.get("/deriv/callback", response_class=HTMLResponse)
async def deriv_callback() -> HTMLResponse:
    """OAuth redirect target. Forwards the #fragment to the app root client-side."""
    return HTMLResponse(
        """<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Signing in…</title></head>
  <body style="margin:0;background:#000;color:#94a3b8;font-family:sans-serif;padding:2rem">
    <p>Signing you in…</p>
    <script>location.replace("/" + location.hash);</script>
  </body>
</html>""",
        status_code=200,
    )
