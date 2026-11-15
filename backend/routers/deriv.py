"""Deriv integration endpoints (new Deriv API platform, developers.deriv.com).

Public market data stays in the browser. OAuth/PAT credentials and authenticated
Demo sockets stay in backend memory, behind an HttpOnly session cookie and CSRF
protection. MongoDB stores only account locks and credential-free order records.
Live accounts and live WebSocket URLs are rejected before any order operation.
"""

import logging
import os
import secrets
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from lib.deriv_demo import Broker, DemoError, RunConfig, COOKIE

router = APIRouter()
log = logging.getLogger(__name__)

TEST_APP_ID = "1089"
PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public"
API_BASE = "https://api.derivws.com"
OAUTH_AUTHORIZE_URL = "https://auth.deriv.com/oauth2/auth"
OAUTH_TOKEN_URL = "https://auth.deriv.com/oauth2/token"
_broker = None


def broker():
    global _broker
    if _broker is None:
        from lib.db import db
        _broker = Broker(db)
    return _broker


def allowed_origins():
    values = {v.strip().rstrip("/") for v in os.environ.get("CORS_ORIGINS", "").split(",") if v.strip() and v.strip() != "*"}
    return values or {"https://deriv-edge-lab-1.onrender.com", "http://localhost:3000", "http://127.0.0.1:3000"}


def origin(request):
    value = request.headers.get("origin", "")
    if value not in allowed_origins():
        raise HTTPException(403, "This website origin is not allowed. Configure CORS_ORIGINS with the frontend origin.")
    return value


def session(request, mutate=False):
    s = broker().sessions.get(request.cookies.get(COOKIE, ""))
    if not s or s.expires <= time.time():
        raise HTTPException(401, "Sign in to the Demo account again.")
    if request.headers.get("origin") and request.headers["origin"] != s.origin:
        raise HTTPException(403, "Session origin mismatch.")
    if mutate and (origin(request) != s.origin or not secrets.compare_digest(request.headers.get("x-deriv-csrf", ""), s.csrf)):
        raise HTTPException(403, "Demo session protection failed. Reload and reconnect.")
    return s


async def checked(awaitable):
    try:
        return await awaitable
    except DemoError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    except Exception:
        raise HTTPException(503, "Demo service unavailable. Check MongoDB read/write access and reconnect; no buy is automatically retried.") from None


def set_session_cookie(response, s):
    response.set_cookie(COOKIE, s.sid, max_age=max(1, int(s.expires - time.time())),
                        httponly=True, secure=urlsplit(s.origin).scheme == "https", samesite="lax", path="/api/deriv")


def _app_id() -> str:
    return (os.environ.get("DERIV_APP_ID", "") or "").strip() or TEST_APP_ID


class DerivConfig(BaseModel):
    app_id: str
    public_ws_url: str
    api_base: str
    oauth_ready: bool
    oauth_authorize_url: str
    demo_execution_enabled: bool


class TokenExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=4096)
    code_verifier: str = Field(min_length=43, max_length=128)
    redirect_uri: str = Field(min_length=1, max_length=2048)


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
        demo_execution_enabled=os.environ.get("DERIV_DEMO_TRADING_ENABLED", "").lower() == "true",
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


@router.post("/deriv/token")
async def deriv_token(body: TokenExchangeRequest, request: Request, response: Response):
    """Exchange PKCE server-side, verify a Demo account and issue an HttpOnly session."""
    app_id = _app_id()
    if app_id == TEST_APP_ID:
        raise HTTPException(status_code=400, detail="OAuth is not configured: set DERIV_APP_ID")
    if not body.redirect_uri.endswith("/api/deriv/callback"):
        raise HTTPException(status_code=400, detail="redirect_uri must point at /api/deriv/callback")
    uri = urlsplit(body.redirect_uri)
    redirect_origin = uri.scheme + "://" + uri.netloc
    if redirect_origin not in allowed_origins() or uri.path != "/api/deriv/callback" or uri.query or uri.fragment:
        raise HTTPException(400, "Redirect URI must use the registered frontend origin and callback path.")
    if origin(request) != redirect_origin:
        raise HTTPException(400, "OAuth must return through the same frontend origin.")

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
        log.info("deriv token exchange failed: http %s", res.status_code)
        raise HTTPException(status_code=400, detail="Deriv rejected the login. Sign in again using the registered callback URL.")

    data = res.json()
    token = data.get("access_token")
    if not token:
        raise HTTPException(status_code=502, detail="Deriv returned no access token")
    s = await checked(broker().create(token, "oauth", int(data.get("expires_in") or 3600), redirect_origin))
    set_session_cookie(response, s)
    return s.public()


class TokenConnect(BaseModel):
    token: str = Field(min_length=1, max_length=8192, repr=False)


class AccountSelect(BaseModel):
    account_id: str = Field(min_length=1, max_length=80)


class RunControl(BaseModel):
    action: str


@router.post("/deriv/session")
async def token_session(body: TokenConnect, request: Request, response: Response):
    s = await checked(broker().create(body.token, "pat", 3600, origin(request)))
    set_session_cookie(response, s)
    return s.public()


@router.get("/deriv/session")
async def session_status(request: Request):
    return session(request).public()


@router.post("/deriv/account")
async def account_select(body: AccountSelect, request: Request):
    s = session(request, True)
    async with s.lock:
        await checked(broker().select(s, body.account_id))
    return s.public()


@router.post("/deriv/demo/start")
async def demo_start(body: RunConfig, request: Request):
    s = session(request, True)
    async with s.lock:
        return await checked(broker().start(s, body))


@router.post("/deriv/demo/signal")
async def demo_signal(request: Request):
    s = session(request, True)
    async with s.lock:
        return await checked(broker().signal(s))


@router.post("/deriv/demo/control")
async def demo_control(body: RunControl, request: Request):
    s = session(request, True)
    async with s.lock:
        if body.action == "stop":
            s.status = "done"
        elif body.action == "pause" and s.status == "running":
            s.status = "paused"
        elif body.action == "resume" and s.status == "paused" and s.connected and not broker().limit_reached(s):
            s.status = "running"
        else:
            raise HTTPException(409, "This Demo session cannot perform that action.")
    return s.public()


@router.post("/deriv/disconnect")
async def disconnect(request: Request, response: Response):
    s = session(request, True)
    async with s.lock:
        s.status = "done"
        if not s.pending:
            if s.channel:
                await s.channel.close()
            broker().sessions.pop(s.sid, None)
    response.delete_cookie(COOKIE, path="/api/deriv")
    return {"connected": False, "pending_contract": bool(s.pending)}
