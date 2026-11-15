"""Authorized display tests: all accounts/sockets/data are local controlled doubles."""
import copy
import json
import time
from types import SimpleNamespace
import pytest
from lib.deriv_demo import DemoError
from routers import account_display as A, deriv
from tests.test_demo_execution import FakeBroker, TOKEN, ORIGIN, DEMO, REAL, demo_http

STATEMENT = {"statement": {"transactions": [
    {"transaction_id": 10, "transaction_time": 1000, "action_type": "buy", "amount": -100, "balance_after": 9900, "contract_id": 1},
    {"transaction_id": 11, "transaction_time": 1002, "action_type": "sell", "amount": 109, "balance_after": 10009, "contract_id": 1}]}}
PROFITS = {"profit_table": {"transactions": [{"transaction_id": 11, "contract_id": 1, "buy_price": 100, "sell_price": 109, "sell_time": 1002}]}}


class Observer:
    instances = []
    def __init__(self):
        self.calls = []
        self.closed = False
        Observer.instances.append(self)
    async def open(self, url, kind):
        self.kind = kind
    async def request(self, payload):
        assert payload in A.READS
        self.calls.append(copy.deepcopy(payload))
        if "balance" in payload:
            return {"balance": {"balance": 2500, "currency": "EUR", "loginid": "ROT-test"}}
        return copy.deepcopy(STATEMENT if "statement" in payload else PROFITS)
    async def close(self):
        self.closed = True


async def ready(monkeypatch):
    await A.shutdown()
    b = FakeBroker()
    monkeypatch.setattr(deriv, "_broker", b)
    monkeypatch.setattr(A, "ReadChannel", Observer)
    s = await b.create(TOKEN, "oauth", 3600, ORIGIN)
    b.raw_accounts[1]["currency"] = "EUR"
    original = s.channel.request
    async def read(payload):
        if "statement" in payload: return copy.deepcopy(STATEMENT)
        if "profit_table" in payload: return copy.deepcopy(PROFITS)
        return await original(payload)
    s.channel.request = read
    return b, s


@pytest.mark.asyncio
async def test_provider_balance_changes_are_displayed_without_mutating_the_broker(monkeypatch):
    b, s = await ready(monkeypatch)
    before = s.public()
    first = await A.display(s)
    assert first["selected_account"]["balance"] == 10000
    s.channel.balance = 10009
    A._views[s.sid]["snapshots"]["DOT-test"]["next_balance"] = 0
    second = await A.display(s)
    assert second["selected_account"]["balance"] == 10009
    assert second["balance_updated_at"] >= first["balance_updated_at"]
    assert second["transactions"][0]["id"] == "11" and second["contracts"][0]["profit"] == 9
    after = s.public()
    assert before["account"] == after["account"] and before["run"] == after["run"]
    assert all(not any(k in p for k in ("buy", "sell", "proposal")) for p in s.channel.calls)
    assert TOKEN not in json.dumps(second) and "otp=" not in json.dumps(second)
    await b.shutdown()


@pytest.mark.asyncio
async def test_real_selection_is_read_only_and_cannot_change_demo_session(monkeypatch):
    b, s = await ready(monkeypatch)
    before = s.public()
    result = await A.display(s, "ROT-test")
    assert {a["type"] for a in result["accounts"]} == {"demo", "real"}
    assert result["selected_account"] == {"id": "ROT-test", "type": "real", "currency": "EUR", "balance": 2500, "read_only": True}
    assert s.public()["run"] == before["run"] and s.account["id"] == "DOT-test"
    assert Observer.instances[-1].kind == "real"
    assert Observer.instances[-1].calls == list(A.READS)
    await A.display(s, "DOT-test")
    assert Observer.instances[-1].closed
    await b.shutdown()


@pytest.mark.asyncio
async def test_foreign_account_is_rejected_before_otp_and_refresh_is_throttled(monkeypatch):
    b, s = await ready(monkeypatch)
    await A.display(s)
    calls = list(b.rest_calls)
    await A.display(s)
    assert b.rest_calls == calls
    with pytest.raises(DemoError): await A.display(s, "ROT-foreign")
    assert not any("ROT-foreign/otp" in path for _, path in b.rest_calls)
    await b.shutdown()


@pytest.mark.asyncio
async def test_partial_history_failure_is_explicit_and_retains_timestamped_verified_records(monkeypatch):
    b, s = await ready(monkeypatch)
    first = await A.display(s)
    async def unavailable(payload):
        raise DemoError("Mock unauthorized provider payload with private details", 502)
    s.channel.request = unavailable
    A._views[s.sid]["snapshots"]["DOT-test"].update(next_balance=0, next_history=0)
    result = await A.display(s)
    assert result["selected_account"]["balance"] == 10000 and result["balance_status"] == "unavailable"
    assert result["balance_updated_at"] == first["balance_updated_at"]
    assert result["transactions"] == first["transactions"] and result["statement_updated_at"] == first["statement_updated_at"]
    assert result["statement_error"] and result["contracts_error"]
    assert "private details" not in json.dumps(result)
    await b.shutdown()


@pytest.mark.asyncio
async def test_expired_or_disconnected_sessions_close_observers(monkeypatch):
    b, s = await ready(monkeypatch)
    await A.display(s, "ROT-test")
    observer = Observer.instances[-1]
    b.sessions.pop(s.sid)
    await A.cleanup()
    assert observer.closed and s.sid not in A._views
    await b.shutdown()


@pytest.mark.parametrize("payload", [{"buy": 1}, {"sell": 1}, {"proposal": 1}, {"balance": 1, "buy": 1}, {"balance": True}, {"statement":1,"limit":999}, {"transaction":1,"subscribe":1}])
@pytest.mark.asyncio
async def test_observer_exact_allowlist_rejects_trading_and_unbounded_requests(payload):
    with pytest.raises(DemoError): await A.ReadChannel().request(payload)


@pytest.mark.parametrize("url", ["wss://evil.example/trading/v1/options/ws/real?otp=x", "wss://api.derivws.com/trading/v1/options/ws/demo?otp=x", "wss://api.derivws.com/trading/v1/options/ws/real?otp=x&buy=1", "ws://api.derivws.com/trading/v1/options/ws/real?otp=x"])
@pytest.mark.asyncio
async def test_observer_rejects_wrong_host_account_type_and_query(url):
    with pytest.raises(DemoError): await A.ReadChannel().open(url, "real")


@pytest.mark.parametrize("value", [True, None, "", [], float("nan"), float("inf")])
def test_display_rejects_unverified_monetary_values(value):
    with pytest.raises((ValueError, TypeError)): A.number(value)


def test_history_validation_deduplicates_and_does_not_count_open_positions_as_losses():
    response = copy.deepcopy(STATEMENT)
    response["statement"]["transactions"] *= 2
    assert len(A.statement_rows(response)) == 2
    response = copy.deepcopy(PROFITS)
    response["profit_table"]["transactions"].append({"transaction_id":12,"sell_time":None})
    assert len(A.contract_rows(response)) == 1
    response = copy.deepcopy(STATEMENT)
    response["statement"]["transactions"][0].pop("amount")
    with pytest.raises(ValueError): A.statement_rows(response)


def test_display_http_is_authenticated_private_and_preserves_existing_execution_routes(demo_http):
    client, b = demo_http
    assert client.get("/api/deriv/account-display").status_code == 401
    login = client.post("/api/deriv/session", json={"token":TOKEN}, headers={"Origin":ORIGIN})
    assert login.status_code == 200
    result = client.get("/api/deriv/account-display")
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store, private"
    assert result.json()["selected_account"]["balance"] == 10000
    assert result.json()["statement_updated_at"] is None and result.json()["statement_error"]
    assert client.get("/api/deriv/account-display", headers={"Origin":"https://evil.example"}).status_code == 403
    assert client.get("/api/deriv/account-display?account_id=ROT-foreign").status_code == 403
    assert not any("buy" in p for s in b.sessions.values() for p in s.channel.calls)


@pytest.mark.asyncio
async def test_mismatched_provider_account_or_currency_cannot_replace_a_verified_balance(monkeypatch):
    b, s = await ready(monkeypatch)
    first = await A.display(s)
    async def wrong(payload):
        return {"balance": {"currency": "EUR", "balance": 999999, "loginid": "ROT-other"}}
    s.channel.request = wrong
    A._views[s.sid]["snapshots"]["DOT-test"]["next_balance"] = 0
    result = await A.display(s)
    assert result["selected_account"]["balance"] == 10000
    assert result["balance_status"] == "unavailable" and result["balance_updated_at"] == first["balance_updated_at"]
    await b.shutdown()


@pytest.mark.asyncio
async def test_observer_valid_real_connection_can_only_send_an_exact_read(monkeypatch):
    class Socket:
        def __init__(self): self.sent = None
        async def send(self, raw): self.sent = json.loads(raw)
        async def recv(self): return json.dumps({"req_id":self.sent["req_id"],"balance":{"balance":0,"currency":"USD"}})
        async def close(self): pass
    socket = Socket()
    async def connection(url, **kwargs):
        assert url == "wss://api.derivws.com/trading/v1/options/ws/real?otp=mock-only"
        return socket
    monkeypatch.setattr(A, "connect", connection)
    reader = A.ReadChannel()
    await reader.open("wss://api.derivws.com/trading/v1/options/ws/real?otp=mock-only", "real")
    result = await reader.request({"balance":1})
    assert result["balance"]["balance"] == 0
    assert socket.sent == {"balance":1,"req_id":1}
    await reader.close()


@pytest.mark.asyncio
async def test_provider_revoked_authorization_is_not_reported_as_a_connected_cached_account(monkeypatch):
    b, s = await ready(monkeypatch)
    await A.display(s)
    async def rejected(*args):
        raise DemoError("Sign in again", 401)
    b.rest = rejected
    A._views[s.sid]["next_accounts"] = 0
    with pytest.raises(DemoError) as result:
        await A.display(s)
    assert result.value.status == 401
    await b.shutdown()
