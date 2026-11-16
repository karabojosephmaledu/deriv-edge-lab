"""Capture only public M1 candles and quote scenarios for the frozen M1 protocol.

No account/auth/order APIs. Resume reuses completed market files; wrong-date
provider data is recorded as unavailable and never substituted with recent data.
"""
import argparse
import asyncio
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import time

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public"
FROZEN = ["research/m1/protocol.json", "research/m1/engine.mjs", "scripts/capture-m1-research.py", "scripts/evaluate-m1-research.mjs"]


def stamp(value):
    return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def public_payload(q):
    fields = {
        "ticks_history": {"ticks_history", "start", "end", "count", "style", "granularity"},
        "contracts_for": {"contracts_for"},
        "proposal": {"proposal", "amount", "basis", "currency", "underlying_symbol", "contract_type", "multiplier"},
    }
    operations = set(q) & fields.keys()
    if len(operations) != 1 or set(q) - fields[next(iter(operations))]:
        raise ValueError("Only allowlisted public research reads are permitted")
    return q


def checked_page(response, start, end):
    if response.get("error"):
        raise ValueError("Provider history error: " + str(response["error"].get("code", "unavailable")))
    bars = response.get("candles")
    if not isinstance(bars, list):
        raise ValueError("Provider returned no candle array")
    last = start - 60
    for b in bars:
        t = b.get("epoch")
        if type(t) is not int or t % 60 or not start <= t < end or t <= last:
            raise ValueError("Provider history dates did not match the requested page")
        values = [b.get(k) for k in ("open", "high", "low", "close")]
        if any(type(v) not in (int, float) or not 0 < v < float("inf") for v in values):
            raise ValueError("Invalid provider prices")
        o, h, l, c = values
        if l > min(o, c) or h < max(o, c):
            raise ValueError("Invalid provider OHLC range")
        last = t
    return bars


def write_gzip(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(data, separators=(",", ":")).encode(), mtime=0))
    tmp.replace(path)


async def capture(directory):
    subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *FROZEN], cwd=ROOT, check=True)
    if any(not subprocess.check_output(["git", "ls-files", "--", p], cwd=ROOT, text=True).strip() for p in FROZEN):
        raise ValueError("Commit the protocol, engine and tools before inspecting evaluation data")
    protocol = json.loads((ROOT / FROZEN[0]).read_text())
    start = stamp(protocol["periods"]["training"][0]) - 60 * protocol["warmup_minutes"]
    end = stamp(protocol["periods"]["test"][1])
    frozen = {p: digest(ROOT / p) for p in FROZEN}
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    directory.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(3)

    async def market(symbol):
        path = directory / (symbol + ".json.gz")
        if path.exists():
            old = json.loads(gzip.decompress(path.read_bytes()))
            if old["frozen_sha256"] != frozen or old["requested"] != [start, end]:
                raise ValueError("Existing snapshot has a different frozen protocol")
            print(json.dumps({"symbol": symbol, "reused_bars": len(old["bars"])}), flush=True)
            return old
        async with semaphore, connect(PUBLIC, open_timeout=15, close_timeout=2, max_size=4 * 1024 * 1024) as ws:
            sequence = 0

            async def request(q):
                nonlocal sequence
                sequence += 1
                await ws.send(json.dumps({**public_payload(q), "req_id": sequence}))
                while True:
                    r = json.loads(await asyncio.wait_for(ws.recv(), 25))
                    if r.get("req_id") == sequence:
                        await asyncio.sleep(.25)
                        return r

            data = {"symbol": symbol, "source": PUBLIC, "captured_at": int(time.time()), "frozen_commit": commit,
                    "frozen_sha256": frozen, "requested": [start, end], "bars": [], "unavailable_pages": []}
            for page in range(start, end, 900 * 60):
                stop = min(end, page + 900 * 60)
                response = await request({"ticks_history": symbol, "start": page, "end": str(stop - 1), "count": 1000, "style": "candles", "granularity": 60})
                try:
                    data["bars"].extend(checked_page(response, page, stop))
                except ValueError as exc:
                    data["unavailable_pages"].append({"start": page, "end": stop, "reason": str(exc)})
            if len(data["bars"]) < 5000:
                raise ValueError("Insufficient dated history for " + symbol)
            contracts = (await request({"contracts_for": symbol})).get("contracts_for", {}).get("available", [])
            ranges = [set(c.get("multiplier_range", [])) for kind in ("MULTUP", "MULTDOWN")
                      for c in contracts if c.get("contract_type") == kind and c.get("underlying_symbol") == symbol]
            common = set.intersection(*ranges) if len(ranges) == 2 else set()
            if not common:
                raise ValueError("No verified common Multiplier for " + symbol)
            multiplier = min(common)
            precision = await request({"ticks_history": symbol, "count": 1, "end": "latest", "style": "ticks"})
            pip = precision.get("pip_size")
            if type(pip) not in (int, float) or int(pip) != pip or not 0 <= pip <= 10:
                raise ValueError("Unverified provider precision")
            data["quote"] = {"pip": int(pip), "captured_at": int(time.time()), "historical_executable": False}
            for side, kind in (("BUY", "MULTUP"), ("SELL", "MULTDOWN")):
                response = await request({"proposal": 1, "amount": 1, "basis": "stake", "currency": "USD", "underlying_symbol": symbol,
                                          "contract_type": kind, "multiplier": multiplier})
                q = response.get("proposal") or {}
                data["quote"][side] = {k: q[k] for k in ("ask_price", "commission", "multiplier", "spot_time") if k in q}
                data["quote"][side]["validation_params"] = {name: {key: float(value) for key, value in (q.get("validation_params", {}).get(name) or {}).items() if key in ("min", "max")}
                                                           for name in ("stop_loss", "take_profit")}
                if response.get("error"):
                    data["quote"][side]["error"] = response["error"].get("code", "unavailable")
            write_gzip(path, data)
            print(json.dumps({"symbol": symbol, "bars": len(data["bars"]), "unavailable_pages": len(data["unavailable_pages"]), "multiplier": multiplier}), flush=True)
            return data

    markets = await asyncio.gather(*(market(s) for s in protocol["markets"]))
    manifest = {"version": protocol["version"], "frozen_commit": commit, "frozen_sha256": frozen,
                "markets": [{"symbol": m["symbol"], "bars": len(m["bars"]), "first": m["bars"][0]["epoch"], "last": m["bars"][-1]["epoch"],
                             "unavailable_pages": m["unavailable_pages"], "quote": m["quote"], "sha256": digest(directory / (m["symbol"] + ".json.gz"))} for m in markets]}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"captured_markets": len(markets), "bars": sum(len(m["bars"]) for m in markets)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "research/m1/data")
    asyncio.run(capture(parser.parse_args().output))
