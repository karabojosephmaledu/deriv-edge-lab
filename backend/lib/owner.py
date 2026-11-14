"""Owner-only gate for the AI coach.

The browser sends its Deriv token in `Authorization: Bearer …` (plus
`X-Deriv-Token-Kind: pat` for Personal Access Tokens). We ask Deriv who
that token belongs to (GET /account/v1/nickname, scope account_manage) and
allow the request only when the identity is the configured owner:

* OWNER_NICKNAME (env) must match the Deriv nickname, and
* the first verified owner's `external_reference_id` is pinned in Mongo
  (`app_owner`), so a later lookalike nickname on another identity is refused.

Tokens are never stored or logged — only a SHA-256 of the token is cached
in memory for a few minutes to avoid calling Deriv on every message.
"""

import hashlib
import os
import time
from typing import Dict, Tuple

import httpx
from fastapi import Header, HTTPException

from lib.db import db

API_BASE = "https://api.derivws.com"
CACHE_TTL = 600  # seconds
_cache: Dict[str, Tuple[float, bool]] = {}


def _owner_nickname() -> str:
    return (os.environ.get("OWNER_NICKNAME", "") or "").strip()


async def _lookup_identity(token: str, kind: str) -> Tuple[str, str]:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if kind == "pat":
        headers["Deriv-App-ID"] = (os.environ.get("DERIV_APP_ID", "") or "").strip()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{API_BASE}/account/v1/nickname", headers=headers)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Could not reach Deriv to verify the owner")
    if res.status_code in (401, 403):
        raise HTTPException(status_code=403, detail="Deriv did not confirm this login (needs Account management scope)")
    if res.status_code != 200:
        raise HTTPException(status_code=503, detail="Deriv owner check failed")
    data = (res.json() or {}).get("data") or {}
    return str(data.get("nickname") or ""), str(data.get("external_reference_id") or "")


async def is_owner(token: str, kind: str) -> bool:
    owner = _owner_nickname()
    if not owner or not token:
        return False
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]

    nickname, ref_id = await _lookup_identity(token, kind)
    ok = False
    if nickname and nickname == owner and ref_id:
        pinned = await db.app_owner.find_one({"_id": "owner"})
        if pinned is None:
            await db.app_owner.insert_one({"_id": "owner", "nickname": nickname, "external_reference_id": ref_id})
            ok = True
        else:
            ok = pinned.get("external_reference_id") == ref_id
    _cache[key] = (time.time() + CACHE_TTL, ok)
    return ok


async def require_owner(
    authorization: str = Header(default=""),
    x_deriv_token_kind: str = Header(default="oauth"),
) -> None:
    """FastAPI dependency: 401 without a Deriv token, 403 when it isn't the owner."""
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not token:
        raise HTTPException(status_code=401, detail="Connect your Deriv account to use the AI coach")
    if not await is_owner(token, "pat" if x_deriv_token_kind == "pat" else "oauth"):
        raise HTTPException(status_code=403, detail="The AI coach is available to the app owner only")
