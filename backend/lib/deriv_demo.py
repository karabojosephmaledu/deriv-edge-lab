"""Server-only Deriv Demo execution. Credentials never enter responses or MongoDB.

Orders are sent only on an explicit browser signal during a started Demo run.
The account is checked against Deriv REST and the socket must be the Demo endpoint.
MongoDB holds a per-account lock and an order ledger, so a lost buy response is
never retried and a restart cannot silently submit another order over it.
"""
import asyncio
import contextlib
import json
import math
import os
import secrets
import time
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import quote, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from websockets.asyncio.client import connect

API_BASE = "https://api.derivws.com"
DEMO_PATH = "/trading/v1/options/ws/demo"
SYMBOLS = {f"R_{v}" for v in (10, 25, 50, 75, 100)} | {f"1HZ{v}V" for v in (10, 25, 50, 75, 100)}
MULTS = {10: {400, 1000, 2000, 3000, 4000}, 25: {160, 400, 800, 1200, 1600},
         50: {80, 200, 400, 600, 800}, 75: {50, 100, 200, 300, 500}, 100: {40, 100, 200, 300, 400}}
COOKIE = "deriv_demo_session"
INSTANCE = secrets.token_hex(16)


class DemoError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class DemoRejected(DemoError):
    """An explicit provider rejection, distinct from a lost/unknown response."""


def amount(value):
    try:
        number = Decimal(str(value))
        if not number.is_finite():
            raise ValueError
        return float(number.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    except (ValueError, ArithmeticError):
        raise DemoError("Deriv returned an invalid monetary value.", 502) from None


def demo_url(url):
    p = urlsplit(url)
    if p.scheme != "wss" or p.hostname != "api.derivws.com" or p.path != DEMO_PATH or p.username or p.password or p.port not in (None, 443):
        raise DemoError("Only Deriv's authenticated Demo WebSocket is allowed.", 403)
    return url


def demo_account(accounts, account_id):
    account = next((a for a in accounts if a.get("account_id") == account_id), None)
    if not account or account.get("account_type") != "demo" or account.get("status") != "active":
        raise DemoError("Only an active, authorised Deriv Demo account may be used.", 403)
    if account.get("currency") != "USD":
        raise DemoError("Actual Demo execution currently supports USD Demo accounts.")
    return {"id": account_id, "currency": "USD", "isVirtual": True, "balance": amount(account.get("balance"))}


class RunConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    symbol: str
    product: str
    stake: float = Field(gt=0, le=5000, strict=True)
    digit: int = Field(default=5, ge=0, le=9, strict=True)
    growth: float = 0.03
    mult: int = Field(default=100, strict=True)
    direction: str = "up"
    target: float | None = Field(default=None, gt=0, strict=True)
    max_loss: float | None = Field(default=None, gt=0, strict=True)
    max_trades: int = Field(default=1000, ge=1, le=1000, strict=True)

    @model_validator(mode="after")
    def supported(self):
        if self.symbol not in SYMBOLS or self.product not in {"differs", "accu", "mult"}:
            raise ValueError("Unsupported market or product")
        if self.direction not in {"up", "down"} or self.growth not in {.01, .02, .03, .04, .05}:
            raise ValueError("Unsupported direction or growth rate")
        minimum, maximum = {"differs": (.35, 5000), "accu": (1, 200), "mult": (1, 500)}[self.product]
        if not minimum <= self.stake <= maximum or amount(self.stake) != self.stake:
            raise ValueError("Stake must be within the product limits and use cents")
        index = int(self.symbol[3:-1] if self.symbol.startswith("1HZ") else self.symbol[2:])
        if self.product == "mult" and self.mult not in MULTS[index]:
            raise ValueError("Unsupported multiplier for this market")
        return self

    def proposal(self):
        q = {"proposal": 1, "amount": self.stake, "basis": "stake", "currency": "USD",
             "underlying_symbol": self.symbol, "subscribe": 1}
        if self.product == "differs":
            q.update(contract_type="DIGITDIFF", barrier=str(self.digit), duration=1, duration_unit="t")
        else:
            q["limit_order"] = {"take_profit": amount(max(.1, self.stake * .1))}
            if self.product == "accu":
                q.update(contract_type="ACCU", growth_rate=self.growth)
            else:
                q.update(contract_type="MULTUP" if self.direction == "up" else "MULTDOWN", multiplier=self.mult)
        return q


class Channel:
    def __init__(self, on_message, on_close):
        self.on_message, self.on_close = on_message, on_close
        self.ws = None
        self.pending = {}
        self.seq = 0
        self.task = None
        self.closed = False

    async def open(self, url):
        self.ws = await connect(demo_url(url), open_timeout=10, close_timeout=3, ping_interval=20, max_size=2**20)
        self.task = asyncio.create_task(self.listen())

    async def listen(self):
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                future = self.pending.pop(message.get("req_id"), None)
                if future and not future.done():
                    if message.get("error"):
                        future.set_exception(DemoRejected("Deriv rejected the Demo request. Check the account, stake and contract availability."))
                    else:
                        future.set_result(message)
                self.on_message(message)
        except Exception:
            pass  # Never log an OTP URL, credential or provider payload.
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(DemoError("Demo connection interrupted. No order will be retried.", 502))
            self.pending.clear()
            if not self.closed:
                self.on_close()

    async def request(self, payload):
        if not self.ws or self.closed:
            raise DemoError("The Demo account is disconnected.", 409)
        self.seq += 1
        req_id = self.seq
        future = asyncio.get_running_loop().create_future()
        self.pending[req_id] = future
        try:
            await self.ws.send(json.dumps({**payload, "req_id": req_id}))
            return await asyncio.wait_for(future, 15)
        except (asyncio.TimeoutError, OSError):
            raise DemoError("Demo request timed out. An order will never be resubmitted automatically.", 502) from None
        finally:
            self.pending.pop(req_id, None)

    async def close(self):
        self.closed = True
        if self.ws:
            await self.ws.close()
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task


@dataclass
class Session:
    token: str = field(repr=False)
    kind: str
    expires: float
    origin: str
    sid: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)
    session_view: str = field(default_factory=lambda: secrets.token_hex(12))
    revision: int = 0
    accounts: list = field(default_factory=list)
    account: dict | None = None
    owner: str | None = None
    channel: object = field(default=None, repr=False)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    cfg: RunConfig | None = None
    run_id: str | None = None
    status: str = "idle"
    error: str | None = None
    connected: bool = False
    net: float = 0
    history: list = field(default_factory=list)
    pending: dict | None = None
    last_tick: dict | None = None
    epochs: list = field(default_factory=list)
    last_entry: int = 0
    needs_history: bool = False
    monitor: object = field(default=None, repr=False)

    def public(self):
        self.revision += 1
        return {"connected": self.connected, "csrf": self.csrf, "session_view": self.session_view,
                "revision": self.revision, "accounts": self.accounts,
                "account": self.account, "owner": self.owner, "expires_at": self.expires,
                "run": {"id": self.run_id, "status": self.status, "net": self.net,
                        "history": self.history, "pending": self.pending, "error": self.error}}


class Broker:
    def __init__(self, db, channel_factory=Channel):
        self.db, self.channel_factory = db, channel_factory
        self.sessions = {}

    async def rest(self, s, method, path):
        headers = {"Authorization": "Bearer " + s.token, "Deriv-App-ID": os.environ.get("DERIV_APP_ID", "1089")}
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.request(method, API_BASE + path, headers=headers, **({"json": {}} if method == "POST" else {}))
            if response.status_code in (401, 403):
                raise DemoError("Deriv rejected the account session. Sign in again with the required permissions.", 401)
            if response.status_code != 200:
                raise DemoError("Deriv's account API is unavailable. Retry the connection later.", 502)
            return response.json()
        except (httpx.HTTPError, ValueError):
            raise DemoError("Could not reach Deriv's account API.", 502) from None

    async def list_accounts(self, s):
        raw = (await self.rest(s, "GET", "/trading/v1/options/accounts")).get("data")
        if not isinstance(raw, list):
            raise DemoError("Deriv returned an unexpected account response.", 502)
        return raw

    async def create(self, token, kind, expires, origin):
        for key, old in list(self.sessions.items()):
            if old.expires <= time.time():
                old.status = "done"
                if old.monitor:
                    old.monitor.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await old.monitor
                if old.channel:
                    await old.channel.close()
                self.sessions.pop(key, None)
        if len(self.sessions) >= 256:
            raise DemoError("Too many active account sessions. Disconnect an unused session first.", 429)
        s = Session(token=token, kind=kind, expires=time.time() + min(expires, 3600), origin=origin)
        raw = await self.list_accounts(s)
        demos = [a for a in raw if a.get("account_type") == "demo" and a.get("status") == "active" and a.get("currency") == "USD"]
        if not demos:
            raise DemoError("No active USD Options Demo account was returned. Live-account execution is blocked.", 403)
        s.accounts = [demo_account(raw, a["account_id"]) for a in demos]
        with contextlib.suppress(DemoError):
            nickname = (await self.rest(s, "GET", "/account/v1/nickname")).get("data") or {}
            s.owner = nickname.get("nickname")
        try:
            await self.select(s, demos[0]["account_id"])
        except Exception:
            if s.channel:
                await s.channel.close()
            raise
        self.sessions[s.sid] = s
        return s

    async def select(self, s, account_id):
        if s.pending or s.status in {"running", "paused"}:
            raise DemoError("Stop the Demo session and let its contract settle before switching accounts.", 409)
        account = demo_account(await self.list_accounts(s), account_id)
        otp = await self.rest(s, "POST", "/trading/v1/options/accounts/" + quote(account_id, safe="") + "/otp")
        url = demo_url((otp.get("data") or {}).get("url", ""))
        if s.channel:
            await s.channel.close()
        s.connected = False
        s.account = account
        s.last_tick = None
        s.epochs = []
        s.cfg, s.run_id, s.status, s.error = None, None, "idle", None
        s.net, s.history, s.last_entry, s.needs_history = 0, [], 0, False
        s.channel = self.channel_factory(lambda m: self.message(s, m), lambda: self.disconnected(s))
        await s.channel.open(url)
        response = await s.channel.request({"balance": 1, "subscribe": 1})
        self.balance(s, response.get("balance"))
        s.connected = True
        # Restore monitoring of an acknowledged order after a browser/backend restart.
        saved = await self.db.demo_account_locks.find_one({"_id": account_id})
        if saved and saved.get("state") != "idle":
            order = await self.db.demo_orders.find_one({"_id": saved.get("order_id")})
            s.status = "done"
            if order and order.get("contract_id"):
                s.pending = self.order_public(order)
                s.cfg = RunConfig(**order["config"])
                s.run_id = order["run_id"]
                previous = await self.db.demo_orders.find({"account_id": account_id, "run_id": s.run_id,
                    "status": {"$in": ["win", "loss", "break-even"]}}).sort("opened_at", -1).to_list(length=1000)
                previous = [row for row in previous if row["_id"] != order["_id"]]
                s.history = [self.order_public(row) for row in previous]
                s.net = amount(sum(row["profit"] for row in previous))
                await s.channel.request({"ticks": s.cfg.symbol, "subscribe": 1})
                s.monitor = asyncio.create_task(self.monitor(s, order, recover=True))
            else:
                s.error = "An earlier buy has an unknown result. New orders are blocked until its Deriv statement is reconciled; do not retry the buy."

    def balance(self, s, data):
        if not isinstance(data, dict) or data.get("currency") != s.account["currency"] or data.get("balance") is None:
            raise DemoError("Deriv did not verify the selected Demo balance and currency.", 502)
        s.account["balance"] = amount(data["balance"])
        for account in s.accounts:
            if account["id"] == s.account["id"]:
                account["balance"] = s.account["balance"]

    def message(self, s, message):
        if message.get("error"):
            return
        if message.get("msg_type") == "balance":
            try:
                self.balance(s, message.get("balance"))
            except DemoError:
                self.disconnected(s)
        tick = message.get("tick")
        if tick and s.cfg and tick.get("symbol") == s.cfg.symbol:
            epoch = tick.get("epoch")
            price = tick.get("quote")
            if not isinstance(epoch, int) or isinstance(epoch, bool) or not isinstance(price, (int, float)) or isinstance(price, bool) or not math.isfinite(price) or price <= 0:
                return
            if s.last_tick and epoch <= s.last_tick["epoch"]:
                return
            interval = 1 if s.cfg.symbol.startswith("1HZ") else 2
            if s.last_tick and epoch - s.last_tick["epoch"] > interval:
                s.needs_history = True
                s.status = "done"
                s.error = "Demo ticks were interrupted. New entries stopped; the current contract still uses Deriv's actual result."
            s.last_tick = {"epoch": epoch, "received": time.monotonic()}
            s.epochs.append(epoch)
            s.epochs = s.epochs[-5000:]

    def disconnected(self, s):
        s.connected = False
        s.status = "done"
        s.error = "Demo connection interrupted. New entries stopped; reconnect to recover the existing contract."

    @staticmethod
    def order_public(order):
        return {k: order.get(k) for k in ("id", "contract_id", "product", "stake", "symbol", "digit", "label", "profit", "status", "opened_at", "closed_at", "buy_price", "sell_price")}

    def limit_reached(self, s):
        c = s.cfg
        if (c.target is not None and s.net >= c.target) or (c.max_loss is not None and s.net <= -c.max_loss) or len(s.history) >= c.max_trades:
            s.status = "done"
            return True
        return False

    async def start(self, s, cfg):
        if os.environ.get("DERIV_DEMO_TRADING_ENABLED", "").lower() != "true":
            raise DemoError("Demo execution is disabled on the backend. Enable DERIV_DEMO_TRADING_ENABLED after deployment approval.", 403)
        if s.pending or s.status in {"running", "paused"}:
            raise DemoError("A Demo session or contract already exists. Use its controls.", 409)
        if not s.connected or s.expires <= time.time():
            raise DemoError("Reconnect the Demo account before starting.", 401)
        demo_account(await self.list_accounts(s), s.account["id"])
        saved = await self.db.demo_account_locks.find_one({"_id": s.account["id"]})
        if saved and saved.get("state") != "idle":
            raise DemoError("A previous Demo order is unresolved. Reconnect to recover it; a new order is blocked.", 409)
        portfolio = await s.channel.request({"portfolio": 1})
        contracts = (portfolio.get("portfolio") or {}).get("contracts")
        if not isinstance(contracts, list):
            raise DemoError("Deriv did not verify the open-contract portfolio.", 502)
        if contracts:
            raise DemoError("The Demo account already has open contracts. Let them finish before starting.", 409)
        s.cfg, s.run_id, s.status, s.error = cfg, secrets.token_hex(16), "running", None
        s.net, s.history, s.last_entry, s.last_tick, s.epochs, s.needs_history = 0, [], 0, None, [], False
        await s.channel.request({"forget_all": "ticks"})
        await s.channel.request({"ticks": cfg.symbol, "subscribe": 1})
        return s.public()

    async def signal(self, s):
        if os.environ.get("DERIV_DEMO_TRADING_ENABLED", "").lower() != "true":
            s.status = "done"
            raise DemoError("Demo execution was disabled on the backend. No new order was placed.", 403)
        if s.status != "running" or s.pending:
            return s.public()
        if not s.connected or s.expires <= time.time():
            raise DemoError("Reconnect the Demo account before placing orders.", 401)
        if self.limit_reached(s):
            return s.public()
        c, tick = s.cfg, s.last_tick
        if not tick or time.monotonic() - tick["received"] > 5 or time.time() - tick["epoch"] > 10:
            return s.public()  # Never accept browser prices or generated ticks as execution data.
        if tick["epoch"] <= s.last_entry:
            return s.public()
        if c.max_loss is not None and s.net - c.stake < -c.max_loss - 1e-9:
            s.status = "done"
            return s.public()
        demo_account(await self.list_accounts(s), s.account["id"])
        balance = await s.channel.request({"balance": 1})
        self.balance(s, balance.get("balance"))
        if s.account["balance"] < c.stake:
            raise DemoError("The Demo account has insufficient available balance.")
        portfolio = await s.channel.request({"portfolio": 1})
        contracts = (portfolio.get("portfolio") or {}).get("contracts")
        if not isinstance(contracts, list):
            raise DemoError("Deriv did not verify the open-contract portfolio.", 502)
        if contracts:
            raise DemoError("An existing account contract blocks another entry.", 409)
        quote_response = await s.channel.request(c.proposal())
        proposal = quote_response.get("proposal") or {}
        price = amount(proposal.get("ask_price"))
        if not proposal.get("id") or price <= 0 or price != c.stake:
            raise DemoError("The authenticated Demo quote does not match the requested stake.", 502)
        order_id = s.run_id + ":" + str(tick["epoch"])
        try:
            await self.db.demo_account_locks.find_one_and_update(
                {"_id": s.account["id"], "state": "idle"},
                {"$set": {"state": "ordering", "order_id": order_id, "instance": INSTANCE}},
                upsert=True, return_document=ReturnDocument.AFTER)
        except DuplicateKeyError:
            raise DemoError("Another Demo order is active or unresolved; no duplicate was submitted.", 409) from None
        order = {"_id": order_id, "id": order_id, "run_id": s.run_id, "account_id": s.account["id"],
                 "config": c.model_dump(), "product": c.product, "stake": c.stake, "symbol": c.symbol,
                 "digit": c.digit, "label": {"differs": f"Differs {c.digit}", "accu": f"Accumulator {c.growth:.0%}", "mult": f"Multiplier ×{c.mult} {c.direction}"}[c.product],
                 "status": "ordering", "profit": None, "opened_at": time.time(), "contract_id": None}
        try:
            await self.db.demo_orders.insert_one(order)
        except Exception:
            # No buy has been sent, so releasing this lock cannot duplicate one.
            with contextlib.suppress(Exception):
                await self.db.demo_account_locks.update_one(
                    {"_id": s.account["id"], "order_id": order_id}, {"$set": {"state": "idle"}})
                subscription = (quote_response.get("subscription") or {}).get("id")
                if subscription:
                    await s.channel.request({"forget": subscription})
            s.status = "done"
            raise
        s.pending = self.order_public(order)
        s.last_entry = tick["epoch"]
        try:
            receipt = (await s.channel.request({"buy": str(proposal["id"]), "price": price})).get("buy") or {}
            if not isinstance(receipt.get("contract_id"), int):
                raise DemoError("Deriv did not return a contract ID. The buy will not be retried.", 502)
            order.update(contract_id=receipt["contract_id"], buy_price=amount(receipt.get("buy_price")), status="open")
            await self.db.demo_orders.update_one({"_id": order_id}, {"$set": {k: order[k] for k in ("contract_id", "buy_price", "status")}})
            await self.db.demo_account_locks.update_one({"_id": s.account["id"], "order_id": order_id}, {"$set": {"state": "open"}})
            s.pending = self.order_public(order)
            s.monitor = asyncio.create_task(self.monitor(s, order))
        except DemoRejected:
            await self.db.demo_orders.update_one({"_id": order_id}, {"$set": {"status": "rejected"}})
            await self.db.demo_account_locks.update_one({"_id": s.account["id"], "order_id": order_id}, {"$set": {"state": "idle"}})
            s.pending = None
            s.status = "done"
            s.error = "Deriv explicitly rejected the buy. No contract was purchased; correct the settings before starting again."
            raise DemoError(s.error) from None
        except Exception:
            s.status = "done"
            s.error = "Demo buy outcome is unresolved. No retry was sent; reconnect to recover its contract or reconcile it with Deriv."
            # The durable lock remains: never guess that a failed response means no buy.
            raise DemoError(s.error, 502) from None
        finally:
            with contextlib.suppress(Exception):
                subscription = (quote_response.get("subscription") or {}).get("id")
                if subscription:
                    await s.channel.request({"forget": subscription})
        return s.public()

    async def monitor(self, s, order, recover=False):
        sell_requested = bool(order.get("sell_requested"))
        try:
            while s.connected:
                info = (await s.channel.request({"proposal_open_contract": 1, "contract_id": order["contract_id"]})).get("proposal_open_contract") or {}
                if info.get("contract_id") != order["contract_id"]:
                    raise DemoError("Deriv returned a different contract.", 502)
                if info.get("is_sold") == 1:
                    profit = amount(info.get("profit"))
                    buy_price, sell_price = amount(info.get("buy_price")), amount(info.get("sell_price"))
                    if amount(sell_price - buy_price) != profit:
                        raise DemoError("Deriv's final contract amounts are inconsistent.", 502)
                    s.last_entry = max(s.last_entry, int(info.get("exit_spot_time") or info.get("current_spot_time") or info.get("sell_time") or time.time()))
                    order.update(status="win" if profit > 0 else "loss" if profit < 0 else "break-even", profit=profit,
                                 buy_price=buy_price, sell_price=sell_price, closed_at=time.time())
                    await self.db.demo_orders.update_one({"_id": order["_id"]}, {"$set": {k: order[k] for k in ("status", "profit", "buy_price", "sell_price", "closed_at")}})
                    await self.db.demo_account_locks.update_one({"_id": order["account_id"], "order_id": order["_id"]}, {"$set": {"state": "idle"}})
                    s.net = amount(s.net + profit)
                    s.history.insert(0, self.order_public(order))
                    self.limit_reached(s)
                    try:
                        self.balance(s, (await s.channel.request({"balance": 1})).get("balance"))
                    except Exception:
                        s.connected = False
                        s.status = "done"
                        s.error = "Contract settlement verified, but the balance refresh failed. Reconnect before trading again."
                    finally:
                        s.pending = None
                    return
                if info.get("profit") is not None:
                    s.pending["profit"] = amount(info["profit"])
                if s.cfg.product == "mult" and info.get("entry_spot_time"):
                    entry = int(info["entry_spot_time"])
                    if recover or s.needs_history:
                        h = await s.channel.request({"ticks_history": s.cfg.symbol, "start": entry, "end": "latest", "style": "ticks", "count": 5000})
                        s.epochs = list((h.get("history") or {}).get("times") or [])
                        recover = False
                        s.needs_history = False
                    if not sell_requested and len({t for t in s.epochs if t > entry}) >= 120:
                        sell_requested = True
                        await self.db.demo_orders.update_one({"_id": order["_id"]}, {"$set": {"sell_requested": True}})
                        with contextlib.suppress(DemoError):
                            await s.channel.request({"sell": order["contract_id"], "price": 0})
                        # Only the subsequent sold-contract response determines final P/L.
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except Exception:
            s.status = "done"
            s.error = "Demo monitoring interrupted. The account lock is retained; reconnect to recover the actual Deriv result."

    async def shutdown(self):
        for s in self.sessions.values():
            s.status = "done"
            if s.monitor:
                s.monitor.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await s.monitor
            if s.channel:
                await s.channel.close()
        self.sessions.clear()
