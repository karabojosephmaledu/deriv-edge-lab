"""Display-only account information. No order, login, callback or configuration changes."""
import asyncio
import contextlib
import time
from fastapi import APIRouter, Request
from lib.deriv_demo import DemoError, amount
from routers import deriv

router = APIRouter()
_cache = {}


async def account_view(s):
    broker = deriv.broker()
    for key in list(_cache):
        if key not in broker.sessions:
            _cache.pop(key, None)
    view = _cache.setdefault(s.sid, {"linked_accounts": [], "accounts_updated_at": None,
        "balance_updated_at": None, "balance_account": None, "accounts_error": None,
        "balance_error": None, "next_balance": 0, "next_accounts": 0, "busy": False})
    now = time.monotonic()
    refresh_balance = now >= view["next_balance"] or view["balance_account"] != (s.account or {}).get("id") or view.get("channel") is not s.channel
    refresh_accounts = now >= view["next_accounts"]
    if not view["busy"] and (refresh_balance or refresh_accounts):
        view["busy"] = True
        channel, selected_id = s.channel, (s.account or {}).get("id")
        async def balance():
            view["next_balance"] = now + 10
            if not s.connected or not channel:
                view["balance_error"] = "Demo balance connection is unavailable. Reconnect the account."
                return
            try:
                response = await channel.request({"balance": 1})
                if s.channel is channel and (s.account or {}).get("id") == selected_id:
                    broker.balance(s, response.get("balance"))
                    view.update(balance_updated_at=time.time(), balance_account=selected_id, balance_error=None, channel=channel)
            except Exception:
                view["balance_error"] = "Balance refresh failed; the last verified value is timestamped. Retry status or reconnect."
        async def accounts():
            view["next_accounts"] = now + 30
            try:
                raw = await broker.list_accounts(s)
                values = []
                for a in raw:
                    if not isinstance(a, dict) or a.get("status") != "active" or a.get("account_type") not in {"demo", "real"}:
                        continue
                    if not isinstance(a.get("account_id"), str) or not isinstance(a.get("currency"), str):
                        continue
                    with contextlib.suppress(DemoError):
                        values.append({"id": a["account_id"], "type": a["account_type"], "currency": a["currency"],
                            "balance": amount(a.get("balance")), "read_only": True})
                view.update(linked_accounts=values, accounts_updated_at=time.time(), accounts_error=None)
            except Exception:
                view["accounts_error"] = "Account-list refresh failed; listed balances retain their last successful timestamp."
        try:
            jobs = []
            if refresh_balance:
                jobs.append(balance())
            if refresh_accounts:
                jobs.append(accounts())
            await asyncio.gather(*jobs)
        finally:
            view["busy"] = False
    return {**s.public(), "authorization_status": "authorised", "linked_accounts": view["linked_accounts"],
        "accounts_updated_at": view["accounts_updated_at"], "accounts_error": view["accounts_error"],
        "balance_updated_at": view["balance_updated_at"] if view["balance_account"] == (s.account or {}).get("id") else None,
        "balance_status": "available" if s.connected and not view["balance_error"] else "unavailable",
        "balance_error": view["balance_error"]}


@router.get("/deriv/account-view")
async def read_account_view(request: Request):
    return await deriv.checked(account_view(deriv.session(request)))
