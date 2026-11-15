"""Offline Deriv Demo execution checks. No real credentials, sockets or orders."""
import asyncio
import copy
import json
import os
import time
from types import SimpleNamespace

os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "deriv_demo_test")

import pytest
from fastapi.testclient import TestClient
from pymongo.errors import DuplicateKeyError
from pydantic import ValidationError
from lib.deriv_demo import Broker, DemoError, DemoRejected, RunConfig, Session, demo_url

ORIGIN = "https://deriv-edge-lab-1.onrender.com"
DEMO = {"account_id": "DOT-test", "account_type": "demo", "status": "active", "currency": "USD", "balance": 10000}
REAL = {**DEMO, "account_id": "ROT-test", "account_type": "real"}
TOKEN = "mock-test-credential-never-return-or-persist"


def matches(row, query):
    return all(row.get(k) in v["$in"] if isinstance(v, dict) and "$in" in v else row.get(k) == v for k, v in query.items())


class Collection:
    def __init__(self):
        self.rows = {}
        self.fail_insert = False

    async def find_one(self, query):
        return next((copy.deepcopy(v) for v in self.rows.values() if matches(v, query)), None)

    async def find_one_and_update(self, query, update, upsert=False, **kwargs):
        row = await self.find_one(query)
        if row is None:
            if not upsert:
                return None
            if query["_id"] in self.rows:
                raise DuplicateKeyError("busy")
            row = dict(query)
        row.update(update["$set"])
        self.rows[row["_id"]] = row
        return copy.deepcopy(row)

    async def insert_one(self, row):
        if self.fail_insert:
            raise RuntimeError("mock write denied")
        if row["_id"] in self.rows:
            raise DuplicateKeyError("duplicate")
        self.rows[row["_id"]] = copy.deepcopy(row)

    async def update_one(self, query, update):
        row = await self.find_one(query)
        if row:
            row.update(update["$set"])
            self.rows[row["_id"]] = row

    def find(self, query):
        rows = [copy.deepcopy(v) for v in self.rows.values() if matches(v, query)]
        class Cursor:
            def sort(self, field, direction):
                rows.sort(key=lambda v: v.get(field, 0), reverse=direction < 0)
                return self
            async def to_list(self, length):
                return rows[:length]
        return Cursor()


class FakeChannel:
    def __init__(self, on_message, on_close):
        self.on_message, self.on_close = on_message, on_close
        self.calls = []
        self.balance = 10000
        self.closed = False
        self.sold = False
        self.fail_buy = False
        self.reject_buy = False
        self.final_profit = 7.5
        self.portfolio = []
        self.entry = int(time.time())
        self.stake = 100

    async def open(self, url):
        self.url = demo_url(url)

    async def close(self):
        self.closed = True

    async def request(self, payload):
        self.calls.append(copy.deepcopy(payload))
        if "balance" in payload:
            return {"balance": {"balance": self.balance, "currency": "USD"}}
        if "portfolio" in payload:
            return {"portfolio": {"contracts": self.portfolio}}
        if "proposal" in payload:
            self.stake = payload["amount"]
            return {"proposal": {"id": "p" * 40, "ask_price": self.stake, "payout": self.stake * 1.09},
                    "subscription": {"id": "quote-subscription"}}
        if "buy" in payload:
            if self.reject_buy:
                raise DemoRejected("mock explicit rejection")
            self.balance -= self.stake
            if self.fail_buy:
                raise DemoError("mock lost receipt", 502)
            return {"buy": {"contract_id": 123, "buy_price": self.stake}}
        if "proposal_open_contract" in payload:
            if self.sold:
                self.balance = 10000 + self.final_profit
            return {"proposal_open_contract": {"contract_id": 123, "is_sold": int(self.sold),
                "profit": str(self.final_profit if self.sold else -1.8), "buy_price": str(self.stake),
                "sell_price": str(self.stake + self.final_profit) if self.sold else None,
                "entry_spot_time": self.entry}}
        if "sell" in payload:
            self.sold = True
            return {"sell": {"sold_for": self.stake + self.final_profit}}
        if "ticks_history" in payload:
            return {"history": {"times": list(range(self.entry + 1, self.entry + 121))}}
        return {}


class FakeBroker(Broker):
    def __init__(self, db=None):
        super().__init__(db or SimpleNamespace(demo_orders=Collection(), demo_account_locks=Collection()), FakeChannel)
        self.raw_accounts = [copy.deepcopy(DEMO), copy.deepcopy(REAL)]
        self.rest_calls = []
        self.otp_url = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=mock-one-time-value"

    async def rest(self, s, method, path):
        self.rest_calls.append((method, path))
        if path.endswith("/accounts"):
            return {"data": copy.deepcopy(self.raw_accounts)}
        if path.endswith("/otp"):
            return {"data": {"url": self.otp_url}}
        return {"data": {"nickname": "Demo tester"}}


@pytest.fixture(autouse=True)
def enabled(monkeypatch):
    monkeypatch.setenv("DERIV_DEMO_TRADING_ENABLED", "true")


async def setup(product="differs", **kwargs):
    b = FakeBroker()
    s = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    await b.start(s, RunConfig(symbol="R_100", product=product, stake=100, **kwargs))
    b.message(s, {"tick": {"symbol": "R_100", "quote": 100, "epoch": int(time.time())}})
    return b, s


@pytest.mark.asyncio
async def test_connection_is_demo_only_and_contains_no_credentials():
    b = FakeBroker()
    s = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    assert s.connected and s.account["balance"] == 10000
    public = json.dumps(s.public())
    assert TOKEN not in public and "otp=" not in public and s.sid not in public
    assert [a["id"] for a in s.accounts] == ["DOT-test"]
    assert TOKEN not in repr(s)
    await b.shutdown()


@pytest.mark.asyncio
async def test_authorized_real_accounts_are_rest_only_views_never_execution_selections():
    b = FakeBroker()
    s = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    views = s.public()["linked_accounts"]
    assert {a["type"] for a in views} == {"demo", "real"}
    assert all(a["read_only"] for a in views)
    assert [a["id"] for a in s.accounts] == ["DOT-test"]
    assert not any("ROT-test/otp" in p for _, p in b.rest_calls)
    with pytest.raises(DemoError):
        await b.select(s, "ROT-test")
    assert s.account["id"] == "DOT-test"
    assert TOKEN not in json.dumps(views)
    await b.shutdown()


@pytest.mark.asyncio
async def test_read_only_views_throttle_refresh_and_keep_timestamped_values_on_failure():
    b = FakeBroker()
    s = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    before = copy.deepcopy(s.linked_accounts)
    updated_at = s.accounts_updated_at
    calls = len(b.rest_calls)
    await b.refresh_account_views(s)
    assert len(b.rest_calls) == calls
    async def unavailable(*args):
        raise DemoError("mock upstream unavailable", 502)
    b.rest = unavailable
    s.accounts_checked_at = 0
    await b.refresh_account_views(s)
    assert s.linked_accounts == before and s.accounts_updated_at == updated_at
    assert "refresh failed" in s.accounts_error.lower()
    assert not any("buy" in p or "sell" in p for p in s.channel.calls)
    await b.shutdown()


def test_research_update_keeps_demo_settlement_and_session_limit_calculations_unchanged():
    import ast
    import inspect
    import subprocess
    original = subprocess.check_output(["git", "show", "a5556bc:backend/lib/deriv_demo.py"], text=True)
    tree = ast.parse(original)
    klass = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Broker")
    for name in ["select", "start", "message", "monitor", "limit_reached"]:
        node = next(n for n in klass.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
        assert inspect.getsource(getattr(Broker, name)).strip() == ast.get_source_segment(original, node).strip()


def test_demo_configuration_cannot_accept_an_experimental_digit_policy():
    with pytest.raises(ValidationError):
        RunConfig(symbol="R_100", product="differs", stake=100, digit_mode="cold50")
    assert set(RunConfig.model_fields) == {"symbol", "product", "stake", "digit", "growth", "mult", "direction", "target", "max_loss", "max_trades"}


@pytest.mark.asyncio
async def test_missing_payout_metadata_does_not_change_demo_execution_decisions():
    b, s = await setup(digit=7)
    request = s.channel.request
    async def no_display_payout(payload):
        response = await request(payload)
        if "proposal" in payload:
            response["proposal"].pop("payout", None)
        return response
    s.channel.request = no_display_payout
    await b.signal(s)
    assert s.pending["digit"] == 7 and s.pending["quoted_payout"] is None
    assert len([p for p in s.channel.calls if "buy" in p]) == 1
    await b.shutdown()


@pytest.mark.parametrize("operation", ["buy", "sell", "authorize", "contract_update", "cashier"])
def test_public_capture_retries_cannot_import_order_or_account_requests_from_a_snapshot(operation):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / "scripts" / "capture-research.py"
    spec = importlib.util.spec_from_file_location("research_capture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    proposal = {"proposal": 1, "amount": 1, "basis": "stake", "currency": "USD", "contract_type": "DIGITDIFF"}
    assert module.public_payload(proposal) == proposal
    with pytest.raises(ValueError):
        module.public_payload({**proposal, operation: 1})


@pytest.mark.asyncio
async def test_real_account_and_real_socket_are_rejected_before_connect_or_buy():
    b = FakeBroker()
    s = Session(TOKEN, "oauth", time.time() + 100, ORIGIN)
    with pytest.raises(DemoError):
        await b.select(s, "ROT-test")
    assert not any(p.endswith("/otp") for _, p in b.rest_calls)
    b.otp_url = "wss://api.derivws.com/trading/v1/options/ws/real?otp=mock"
    with pytest.raises(DemoError):
        await b.create(TOKEN, "oauth", 3600, ORIGIN)
    assert not b.sessions


@pytest.mark.parametrize("url", [
    "wss://api.derivws.com/trading/v1/options/ws/real?otp=x",
    "wss://api.derivws.com.evil.example/trading/v1/options/ws/demo?otp=x",
    "ws://api.derivws.com/trading/v1/options/ws/demo?otp=x",
    "wss://user:password@api.derivws.com/trading/v1/options/ws/demo?otp=x",
])
def test_socket_allowlist_cannot_be_bypassed(url):
    with pytest.raises(DemoError):
        demo_url(url)


@pytest.mark.asyncio
async def test_no_buy_without_authenticated_fresh_ticks():
    b, s = await setup()
    s.last_tick = None
    await b.signal(s)
    assert not any("buy" in p for p in s.channel.calls)
    b.message(s, {"tick": {"symbol": "R_25", "quote": 1, "epoch": int(time.time())}})
    await b.signal(s)
    assert not any("buy" in p for p in s.channel.calls)
    await b.shutdown()


@pytest.mark.asyncio
async def test_default_kill_switch_and_mid_session_disable(monkeypatch):
    b = FakeBroker()
    s = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    monkeypatch.delenv("DERIV_DEMO_TRADING_ENABLED")
    with pytest.raises(DemoError):
        await b.start(s, RunConfig(symbol="R_100", product="differs", stake=1))
    monkeypatch.setenv("DERIV_DEMO_TRADING_ENABLED", "true")
    await b.start(s, RunConfig(symbol="R_100", product="differs", stake=1))
    monkeypatch.setenv("DERIV_DEMO_TRADING_ENABLED", "false")
    with pytest.raises(DemoError):
        await b.signal(s)
    assert s.status == "done" and not any("buy" in p for p in s.channel.calls)
    await b.shutdown()


@pytest.mark.parametrize("product,contract", [("differs", "DIGITDIFF"), ("accu", "ACCU"), ("mult", "MULTUP")])
@pytest.mark.asyncio
async def test_actual_proposals_and_single_buy_per_pending_order(product, contract):
    b, s = await setup(product)
    await b.signal(s)
    await b.signal(s)
    proposals = [p for p in s.channel.calls if "proposal" in p]
    buys = [p for p in s.channel.calls if "buy" in p]
    assert len(buys) == 1 and buys[0]["price"] == 100
    assert {"forget": "quote-subscription"} in s.channel.calls
    assert {"forget": "p" * 40} not in s.channel.calls
    assert proposals[0]["subscribe"] == 1 and proposals[0]["contract_type"] == contract
    if product != "differs":
        assert proposals[0]["limit_order"]["take_profit"] == 10
    else:
        assert proposals[0]["duration"] == 1 and proposals[0]["barrier"] == "5"
    assert s.pending["contract_id"] == 123
    assert TOKEN not in json.dumps(b.db.demo_orders.rows)
    await b.shutdown()






@pytest.mark.asyncio
async def test_actual_settlement_and_balance_replace_estimated_payouts():
    b, s = await setup(target=5)
    s.channel.sold = True
    await b.signal(s)
    await s.monitor
    assert s.net == 7.5  # Deliberately differs from the simulator's $9 fallback.
    assert s.history[0]["contract_id"] == 123 and s.history[0]["profit"] == 7.5
    assert s.account["balance"] == 10007.5
    assert s.status == "done" and s.pending is None
    assert b.db.demo_account_locks.rows["DOT-test"]["state"] == "idle"
    await b.shutdown()


@pytest.mark.asyncio
async def test_lost_buy_receipt_is_durable_and_never_retried():
    b, s = await setup()
    s.channel.fail_buy = True
    with pytest.raises(DemoError):
        await b.signal(s)
    await b.signal(s)
    assert len([p for p in s.channel.calls if "buy" in p]) == 1
    assert b.db.demo_account_locks.rows["DOT-test"]["state"] == "ordering"
    other = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    with pytest.raises(DemoError):
        await b.start(other, RunConfig(symbol="R_100", product="differs", stake=100))
    assert "unknown" in other.error
    await b.shutdown()


@pytest.mark.asyncio
async def test_explicit_buy_rejection_is_not_recorded_as_a_loss_or_unknown_purchase():
    b, s = await setup()
    s.channel.reject_buy = True
    with pytest.raises(DemoError):
        await b.signal(s)
    assert s.pending is None and s.history == [] and s.net == 0
    assert b.db.demo_account_locks.rows["DOT-test"]["state"] == "idle"
    assert next(iter(b.db.demo_orders.rows.values()))["status"] == "rejected"
    await b.shutdown()


@pytest.mark.asyncio
async def test_database_write_failure_cannot_submit_an_order():
    b, s = await setup()
    b.db.demo_orders.fail_insert = True
    with pytest.raises(RuntimeError):
        await b.signal(s)
    assert not any("buy" in p for p in s.channel.calls)
    assert b.db.demo_account_locks.rows["DOT-test"]["state"] == "idle"
    assert {"forget": "quote-subscription"} in s.channel.calls
    await b.shutdown()


@pytest.mark.asyncio
async def test_switching_demo_accounts_clears_the_previous_accounts_session_results():
    b, s = await setup()
    s.channel.sold = True
    await b.signal(s)
    await s.monitor
    s.status = "done"
    b.raw_accounts.append({**DEMO, "account_id": "DOT-second"})
    await b.select(s, "DOT-second")
    assert s.account["id"] == "DOT-second"
    assert s.net == 0 and s.history == [] and s.run_id is None and s.cfg is None
    await b.shutdown()


@pytest.mark.asyncio
async def test_account_type_is_rechecked_before_every_buy():
    b, s = await setup()
    b.raw_accounts[0]["account_type"] = "real"
    with pytest.raises(DemoError):
        await b.signal(s)
    assert not any("buy" in p for p in s.channel.calls)
    await b.shutdown()


@pytest.mark.asyncio
async def test_loss_budget_paused_state_and_stale_ticks_prevent_orders():
    b, s = await setup(max_loss=100)
    s.net = -1
    await b.signal(s)
    assert s.status == "done"
    s.net = 0
    s.status = "paused"
    await b.signal(s)
    s.status = "running"
    s.last_tick["received"] -= 10
    await b.signal(s)
    assert not any("buy" in p for p in s.channel.calls)
    await b.shutdown()


@pytest.mark.asyncio
async def test_pending_contract_blocks_new_session_or_account_switch():
    b, s = await setup()
    await b.signal(s)
    s.status = "done"
    with pytest.raises(DemoError):
        await b.start(s, s.cfg)
    with pytest.raises(DemoError):
        await b.select(s, s.account["id"])
    await b.shutdown()


@pytest.mark.asyncio
async def test_multiplier_closes_after_120_actual_ticks_and_uses_final_deriv_result():
    b, s = await setup("mult")
    await b.signal(s)
    s.epochs = list(range(s.channel.entry + 1, s.channel.entry + 121))
    await asyncio.wait_for(s.monitor, 3)
    assert len([p for p in s.channel.calls if "sell" in p]) == 1
    assert s.net == 7.5 and s.history[0]["status"] == "win"
    await b.shutdown()


@pytest.mark.parametrize("fields", [{"stake": True}, {"stake": 0}, {"stake": 100.001}, {"max_loss": float("nan")},
    {"symbol": "not_allowed"}, {"product": "real"}, {"account_type": "demo"}, {"mult": 999, "product": "mult"}])
def test_run_input_validation(fields):
    with pytest.raises((ValidationError, DemoError)):
        RunConfig(**{"symbol": "R_100", "product": "differs", "stake": 100, **fields})


@pytest.fixture
def demo_http(monkeypatch):
    import server
    from routers import deriv
    b = FakeBroker()
    monkeypatch.setattr(deriv, "_broker", b)
    monkeypatch.setenv("CORS_ORIGINS", ORIGIN)
    async def no_indexes():
        pass
    monkeypatch.setattr(server, "ensure_indexes", no_indexes)
    with TestClient(server.app, base_url=ORIGIN) as client:
        yield client, b


def test_http_cookie_csrf_origin_and_secret_handling(demo_http):
    client, b = demo_http
    assert client.post("/api/deriv/demo/start", json={"symbol": "R_100", "product": "differs", "stake": 1}).status_code == 401
    login = client.post("/api/deriv/session", json={"token": TOKEN}, headers={"Origin": ORIGIN})
    assert login.status_code == 200
    assert login.headers["cache-control"] == "no-store, private"
    assert TOKEN not in login.text and TOKEN not in login.headers["set-cookie"]
    cookie = login.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie
    csrf = login.json()["csrf"]
    assert client.post("/api/deriv/demo/start", json={"symbol": "R_100", "product": "differs", "stake": 1}, headers={"Origin": ORIGIN}).status_code == 403
    headers = {"Origin": ORIGIN, "X-Deriv-CSRF": csrf}
    assert client.post("/api/deriv/demo/start", json={"symbol": "R_100", "product": "differs", "stake": 1}, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/deriv/account", json={"account_id": "ROT-test"}, headers=headers).status_code == 403
    assert client.post("/api/deriv/demo/start", json={"symbol": "R_100", "product": "differs", "stake": 1}, headers=headers).status_code == 200
    assert client.post("/api/deriv/demo/control", json={"action": "pause"}, headers=headers).json()["run"]["status"] == "paused"
    assert client.post("/api/deriv/demo/control", json={"action": "stop"}, headers=headers).json()["run"]["status"] == "done"
    assert client.post("/api/deriv/disconnect", json={}, headers=headers).status_code == 200
    assert client.get("/api/deriv/session").status_code == 401


def test_validation_errors_do_not_echo_credentials(demo_http):
    client, _ = demo_http
    value = TOKEN * 300
    response = client.post("/api/deriv/session", json={"token": value}, headers={"Origin": ORIGIN})
    assert response.status_code == 422 and TOKEN not in response.text and '"input"' not in response.text


def test_research_digit_policies_are_rejected_by_the_demo_http_route(demo_http):
    client, b = demo_http
    login = client.post("/api/deriv/session", json={"token": TOKEN}, headers={"Origin": ORIGIN})
    response = client.post("/api/deriv/demo/start", headers={"Origin": ORIGIN, "X-Deriv-CSRF": login.json()["csrf"]},
        json={"symbol": "R_100", "product": "differs", "stake": 1, "digit_mode": "cold50"})
    assert response.status_code == 422
    assert not any(s.cfg for s in b.sessions.values())


def test_oauth_exchange_keeps_access_token_on_backend(demo_http, monkeypatch):
    from routers import deriv
    client, _ = demo_http
    monkeypatch.setenv("DERIV_APP_ID", "public-application-id")
    class Provider:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def post(self, *args, **kwargs):
            return SimpleNamespace(status_code=200, json=lambda: {"access_token": TOKEN, "expires_in": 3600})
    monkeypatch.setattr(deriv.httpx, "AsyncClient", Provider)
    response = client.post("/api/deriv/token", json={"code": "synthetic-authorization-code", "code_verifier": "x" * 43,
        "redirect_uri": ORIGIN + "/api/deriv/callback"}, headers={"Origin": ORIGIN})
    assert response.status_code == 200 and response.json()["connected"]
    assert TOKEN not in response.text and "access_token" not in response.text


@pytest.mark.asyncio
async def test_recovery_does_not_double_count_a_settlement_persisted_before_lock_release_failed():
    b, s = await setup()
    s.channel.sold = True
    original_update = b.db.demo_account_locks.update_one
    async def fail_release(query, update):
        if update["$set"].get("state") == "idle":
            raise RuntimeError("mock interrupted final write")
        return await original_update(query, update)
    b.db.demo_account_locks.update_one = fail_release
    await b.signal(s)
    await s.monitor
    assert s.history == [] and s.pending
    b.db.demo_account_locks.update_one = original_update
    recovered = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    recovered.channel.sold = True
    await recovered.monitor
    assert recovered.net == 7.5 and len(recovered.history) == 1
    assert b.db.demo_account_locks.rows["DOT-test"]["state"] == "idle"
    await b.shutdown()
