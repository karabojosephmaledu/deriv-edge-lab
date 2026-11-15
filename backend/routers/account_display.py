"""Authorized account display only; no trade commands and no broker state changes."""
import asyncio
import contextlib
import json
import math
import time
from urllib.parse import quote, urlsplit, parse_qs
from fastapi import APIRouter, Query, Request
from websockets.asyncio.client import connect
from lib.deriv_demo import DemoError
from routers import deriv

router = APIRouter()
_views = {}
READS = ({"balance": 1}, {"statement": 1, "description": 1, "limit": 50},
         {"profit_table": 1, "description": 1, "limit": 50, "sort": "DESC"})


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)) or isinstance(value, str) and not value.strip():
        raise ValueError("Invalid account number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Invalid account number")
    return result


def identifier(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value) or len(str(value)) > 100:
        raise ValueError("Invalid provider identifier")
    return str(value)


class ReadChannel:
    """A separate observer socket with an exact read-request allowlist."""
    def __init__(self):
        self.ws = None
        self.seq = 0
        self.lock = asyncio.Lock()

    async def open(self, url, kind):
        p = urlsplit(url)
        if p.scheme != "wss" or p.hostname != "api.derivws.com" or p.port not in (None, 443) or p.username or p.password or p.fragment or p.path != "/trading/v1/options/ws/" + kind or set(parse_qs(p.query)) != {"otp"}:
            raise DemoError("Deriv returned an unexpected read-only account connection.", 502)
        self.ws = await connect(url, open_timeout=10, close_timeout=3, ping_interval=20, max_size=2**20)

    async def request(self, payload):
        if not isinstance(payload, dict) or json.dumps(payload, sort_keys=True) not in {json.dumps(q, sort_keys=True) for q in READS}:
            raise DemoError("Only balance and history reads are permitted.", 403)
        async with self.lock:
            if self.ws is None:
                raise DemoError("Account display connection unavailable.", 502)
            self.seq += 1
            req_id = self.seq
            async with asyncio.timeout(15):
                await self.ws.send(json.dumps({**payload, "req_id": req_id}))
                while True:
                    message = json.loads(await self.ws.recv())
                    if message.get("req_id") != req_id:
                        continue
                    if message.get("error"):
                        raise DemoError("Deriv did not authorize this account information request.", 502)
                    return message

    async def close(self):
        if self.ws:
            with contextlib.suppress(Exception):
                await self.ws.close()
        self.ws = None


async def cleanup():
    now = time.monotonic()
    sessions = deriv.broker().sessions
    for key, view in list(_views.items()):
        s = sessions.get(key)
        if (not s or s.expires <= time.time() or now - view["used"] > 120) and not view["lock"].locked():
            _views.pop(key, None)
            if view.get("channel"):
                await view["channel"].close()


async def cleanup_loop():
    while True:
        await asyncio.sleep(30)
        await cleanup()


async def shutdown():
    for view in list(_views.values()):
        if view.get("channel"):
            await view["channel"].close()
    _views.clear()


def statement_rows(response):
    rows = response.get("statement", {}).get("transactions")
    if not isinstance(rows, list) or len(rows) > 50:
        raise ValueError("Unverified statement response")
    result, seen = [], set()
    for row in rows:
        key = identifier(row.get("transaction_id"))
        if key in seen:
            continue
        seen.add(key)
        timestamp = number(row.get("transaction_time"))
        if timestamp <= 0 or row.get("action_type") not in {"buy", "sell", "deposit", "withdrawal", "adjustment"}:
            raise ValueError("Unverified statement row")
        result.append({"id": key, "time": timestamp, "action": row["action_type"], "amount": number(row.get("amount")),
            "balance_after": number(row.get("balance_after")), "contract_id": str(row["contract_id"]) if row.get("contract_id") is not None else None,
            "description": str(row.get("longcode") or row.get("shortcode") or row["action_type"])[:600]})
    return sorted(result, key=lambda r: r["time"], reverse=True)


def contract_rows(response):
    rows = response.get("profit_table", {}).get("transactions")
    if not isinstance(rows, list) or len(rows) > 50:
        raise ValueError("Unverified profit table response")
    result, seen = [], set()
    for row in rows:
        key = identifier(row.get("transaction_id"))
        if key in seen:
            continue
        seen.add(key)
        # An open contract is not a loss and must not enter settled statistics.
        if row.get("sell_time") is None:
            continue
        bought, sold, timestamp = number(row.get("buy_price")), number(row.get("sell_price")), number(row["sell_time"])
        if bought < 0 or sold < 0 or timestamp <= 0:
            raise ValueError("Unverified settled contract")
        result.append({"id": key, "contract_id": str(row["contract_id"]) if row.get("contract_id") is not None else None,
            "time": timestamp, "stake": bought, "return": sold, "profit": float(format(sold - bought, ".10f")),
            "description": str(row.get("longcode") or row.get("shortcode") or row.get("contract_type") or "Settled contract")[:600]})
    return sorted(result, key=lambda r: r["time"], reverse=True)


async def display(s, account_id=None):
    await cleanup()
    b = deriv.broker()
    view = _views.setdefault(s.sid, {"lock": asyncio.Lock(), "used": time.monotonic(), "accounts": [], "next_accounts": 0,
        "accounts_at": None, "accounts_error": None, "current": None, "channel": None, "snapshots": {}})
    view["used"] = time.monotonic()
    async with view["lock"]:
        now = time.monotonic()
        if now >= view["next_accounts"] or account_id and account_id not in {a["id"] for a in view["accounts"]}:
            view["next_accounts"] = now + 30
            try:
                accounts = []
                for a in await b.list_accounts(s):
                    if not isinstance(a, dict) or a.get("status") != "active" or a.get("account_type") not in {"demo", "real"}:
                        continue
                    if not isinstance(a.get("currency"), str) or not a["currency"]:
                        continue
                    key = identifier(a.get("account_id"))
                    accounts.append({"id": key, "type": a["account_type"], "currency": a["currency"], "read_only": True})
                view.update(accounts=accounts, accounts_at=time.time(), accounts_error=None)
            except Exception as exc:
                if isinstance(exc, DemoError) and exc.status == 401:
                    raise
                view["accounts_error"] = "Account list refresh failed. Previously authorized accounts are timestamped; retry status."
        selected = account_id or (s.account or {}).get("id")
        account = next((a for a in view["accounts"] if a["id"] == selected), None)
        if not account:
            raise DemoError("Deriv has not authorized the selected active Options account.", 403)
        changed = view["current"] != selected
        if changed:
            if view.get("channel"):
                await view["channel"].close()
            view.update(current=selected, channel=None)
        data = view["snapshots"].setdefault(selected, {"balance": None, "balance_at": None, "transactions": [], "contracts": [],
            "statement_at": None, "contracts_at": None, "next_balance": 0, "next_history": 0,
            "balance_error": None, "statement_error": None, "contracts_error": None})
        try:
            if (s.account or {}).get("id") == selected and s.connected and s.channel:
                channel = s.channel
            else:
                if not view.get("channel"):
                    response = await b.rest(s, "POST", "/trading/v1/options/accounts/" + quote(selected, safe="") + "/otp")
                    channel = ReadChannel()
                    view["channel"] = channel
                    await channel.open((response.get("data") or {}).get("url", ""), account["type"])
                channel = view["channel"]
            if changed or now >= data["next_balance"]:
                data["next_balance"] = now + 8
                try:
                    balance = (await channel.request(READS[0])).get("balance", {})
                    value = number(balance.get("balance"))
                    if value < 0 or balance.get("currency") != account["currency"] or balance.get("loginid", selected) != selected:
                        raise ValueError("Unverified account balance")
                    # Display only: never overwrite s.account, cfg, run, pending, or its order ledger.
                    data.update(balance=value, balance_at=time.time(), balance_error=None)
                except Exception as exc:
                    if isinstance(exc, DemoError) and exc.status == 401:
                        raise
                    data["balance_error"] = "Balance refresh unavailable. Any last verified value retains its timestamp."
            if changed or now >= data["next_history"]:
                data["next_history"] = now + 15
                for index, key, parser in [(1, "statement", statement_rows), (2, "contracts", contract_rows)]:
                    try:
                        rows = parser(await channel.request(READS[index]))
                        data["transactions" if key == "statement" else "contracts"] = rows
                        data[key + "_at"] = time.time()
                        data[key + "_error"] = None
                    except Exception as exc:
                        if isinstance(exc, DemoError) and exc.status == 401:
                            raise
                        data[key + "_error"] = "Deriv history is unavailable or was not authorized. No transaction or result was substituted."
        except Exception as exc:
            if isinstance(exc, DemoError) and exc.status == 401:
                raise
            data["balance_error"] = "Account display connection unavailable. Retry status or reconnect with Deriv."
            data["statement_error"] = data["contracts_error"] = "History unavailable for the selected account."
        if data["balance_error"] and view.get("channel"):
            await view["channel"].close()
            view["channel"] = None
        return {"authorization_status": "authorised", "session_view": s.session_view, "csrf": s.csrf, "owner": s.owner,
            "accounts": view["accounts"], "accounts_updated_at": view["accounts_at"], "accounts_error": view["accounts_error"],
            "selected_account": {**account, "balance": data["balance"]}, "balance_updated_at": data["balance_at"],
            "balance_status": "available" if data["balance_at"] and not data["balance_error"] else "unavailable",
            "balance_error": data["balance_error"], "transactions": data["transactions"], "statement_updated_at": data["statement_at"],
            "statement_error": data["statement_error"], "contracts": data["contracts"], "contracts_updated_at": data["contracts_at"],
            "contracts_error": data["contracts_error"], "read_only": True}


@router.get("/deriv/account-display")
async def read_display(request: Request, account_id: str | None = Query(default=None, min_length=1, max_length=80)):
    return await deriv.checked(display(deriv.session(request), account_id))
