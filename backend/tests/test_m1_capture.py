"""Read-only data capture validation. Never opens a provider connection."""
import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location("m1_capture", Path(__file__).resolve().parents[2] / "scripts/capture-m1-research.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


@pytest.mark.parametrize("query", [{"buy": "test", "price": 1}, {"authorize": "canary"}, {"proposal": 1, "token": "canary"},
                                   {"ticks_history": "R_100", "proposal": 1}, {"sell": 123}, {"balance": 1}])
def test_capture_rejects_account_and_order_commands(query):
    with pytest.raises(ValueError):
        capture.public_payload(query)


def test_capture_allows_only_the_needed_public_history_query():
    query = {"ticks_history": "R_100", "start": 60, "end": "120", "count": 1000, "style": "candles", "granularity": 60}
    assert capture.public_payload(query) == query


@pytest.mark.parametrize("change", ["future", "duplicate", "outside", "bad_range", "boolean", "nan", "provider_error"])
def test_capture_rejects_wrong_dates_and_malformed_candles(change):
    bar = {"epoch": 60, "open": 100, "high": 101, "low": 99, "close": 100}
    reply = {"candles": [bar]}
    if change == "future":
        bar["epoch"] = 180
    elif change == "outside":
        bar["epoch"] = 0
    elif change == "duplicate":
        reply["candles"].append(dict(bar))
    elif change == "bad_range":
        bar["high"] = 99
    elif change == "boolean":
        bar["open"] = True
    elif change == "nan":
        bar["close"] = float("nan")
    else:
        reply = {"error": {"code": "Unavailable"}}
    with pytest.raises(ValueError):
        capture.checked_page(reply, 60, 180)


def test_closed_market_gaps_are_not_filled_with_synthetic_candles():
    assert capture.checked_page({"candles": []}, 60, 180) == []
