"""Deriv integration endpoints (new Deriv API platform, developers.deriv.com).

The browser talks to Deriv directly for market data (public WebSocket),
account listing and OTP issuing (api.derivws.com allows browser CORS).
This backend only:
  * publishes PUBLIC configuration (app_id, gateway urls) — no secrets;
  * serves the OAuth redirect path, forwarding `?code&state` to the app root
    as a #fragment;
  * performs the OAuth code→token exchange, because auth.deriv.com does not
    allow browser CORS (and Deriv's docs require it server-side). The token
    is returned to the browser and NEVER stored or logged here.
"""

import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

router = APIRouter()
log = logging.getLogger(__name__)

TEST_APP_ID = "1089"
PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public"
API_BASE = "https://api.derivws.com"
OAUTH_AUTHORIZE_URL = "https://auth.deriv.com/oauth2/auth"
OAUTH_TOKEN_URL = "https://auth.deriv.com/oauth2/token"


def _app_id() -> str:
    return (os.environ.get("DERIV_APP_ID", "") or "").strip() or TEST_APP_ID


class DerivConfig(BaseModel):
    app_id: str
    public_ws_url: str
    api_base: str
    oauth_ready: bool
    oauth_authorize_url: str


class TokenExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=4096)
    code_verifier: str = Field(min_length=43, max_length=128)
    redirect_uri: str = Field(min_length=1, max_length=2048)


class TokenExchangeResponse(BaseModel):
    access_token: str
    expires_in: int


@router.get("/deriv/config", response_model=DerivConfig)
async def deriv_config() -> DerivConfig:
    """Public configuration for the browser app. Contains no secrets."""
    app_id = _app_id()
    return DerivConfig(
        app_id=app_id,
        public_ws_url=PUBLIC_WS_URL,
        api_base=API_BASE,
        oauth_ready=app_id != TEST_APP_ID,
        oauth_authorize_url=OAUTH_AUTHORIZE_URL,
    )


@router.get("/deriv/callback", response_class=HTMLResponse)
async def deriv_callback() -> HTMLResponse:
    """OAuth redirect target. Moves ?code&state (or ?error) into the #fragment of "/"."""
    return HTMLResponse(
        """<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Signing in…</title><meta name="referrer" content="no-referrer"></head>
  <body style="margin:0;background:#000;color:#94a3b8;font-family:sans-serif;padding:2rem">
    <p>Signing you in…</p>
    <script>location.replace("/#" + location.search.slice(1));</script>
  </body>
</html>"""
    )


@router.post("/deriv/token", response_model=TokenExchangeResponse)
async def deriv_token(body: TokenExchangeRequest) -> TokenExchangeResponse:
    """Exchange an OAuth authorization code (PKCE) for an access token.

    Stateless: nothing is persisted, and neither the code nor the token is logged.
    """
    app_id = _app_id()
    if app_id == TEST_APP_ID:
        raise HTTPException(status_code=400, detail="OAuth is not configured: set DERIV_APP_ID")
    if not body.redirect_uri.endswith("/api/deriv/callback"):
        raise HTTPException(status_code=400, detail="redirect_uri must point at /api/deriv/callback")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                OAUTH_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "client_id": app_id,
                    "code": body.code,
                    "redirect_uri": body.redirect_uri,
                    "code_verifier": body.code_verifier,
                },
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach Deriv's login server")

    if res.status_code != 200:
        detail = "Deriv rejected the login"
        try:
            err = res.json()
            detail = err.get("error_description") or err.get("error") or detail
        except ValueError:
            pass
        log.info("deriv token exchange failed: http %s", res.status_code)
        raise HTTPException(status_code=400, detail=detail)

    data = res.json()
    token = data.get("access_token")
    if not token:
        raise HTTPException(status_code=502, detail="Deriv returned no access token")
    return TokenExchangeResponse(access_token=token, expires_in=int(data.get("expires_in") or 3600))
