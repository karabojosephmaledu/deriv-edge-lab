"""Capture PUBLIC ticks and quotes only. Never authenticates or submits orders.

Run with the existing backend environment: python scripts/capture-research.py
Requires only websockets, already a backend runtime dependency, and Node.js.
"""
import argparse
import asyncio
import datetime as dt
import json
from pathlib import Path
import subprocess
import time

from websockets.asyncio.client import connect

PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public"
ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"ticks_history", "proposal", "contracts_for"}


async def capture(path):
    output = {"source": PUBLIC, "captured_at": int(time.time()),
              "note": "Public data only. Quote snapshots are current, not historical executable payouts.", "markets": []}
    seq = 0
    async with connect(PUBLIC, open_timeout=15, max_size=4 * 1024 * 1024) as socket:
        async def request(payload):
            nonlocal seq
            if not (set(payload) & ALLOWED) or set(payload) & {"buy", "sell", "authorize", "contract_update"}:
                raise ValueError("Only read-only public research requests are permitted")
            seq += 1
            await socket.send(json.dumps({**payload, "req_id": seq}))
            while True:
                response = json.loads(await asyncio.wait_for(socket.recv(), 25))
                if response.get("req_id") == seq:
                    await asyncio.sleep(1.1)  # serial public reads, no burst/subscription
                    return response

        # Fixed periods chosen before looking at any strategy outcomes.
        for symbol, mult in [("R_100", 100), ("R_25", 400)]:
            market = {"symbol": symbol, "mult": mult, "periods": [], "quotes": {}}
            for days_ago in [2, 1, 0]:
                end = output["captured_at"] - days_ago * 86400 - 60
                response = await request({"ticks_history": symbol, "count": 1000, "start": end - 2000, "end": str(end), "style": "ticks"})
                if response.get("error"):
                    raise RuntimeError("Public history unavailable: " + response["error"].get("code", "unknown"))
                h = response.get("history") or {}
                times = h.get("times", [])
                if not times or times[0] < end - 2000 or times[-1] > end:
                    raise RuntimeError("Provider history does not match the requested date; refusing misleading results")
                market["periods"].append({"symbol": symbol, "prices": list(map(float, h.get("prices", []))),
                    "times": h.get("times", []), "pip": int(response["pip_size"]), "requested_end": end})
            reference = market["periods"][-1]["prices"][-1]
            for label, stake in [("small", .35), ("large", 50)]:
                # Share the exact frontend specifications rather than maintain a second contract definition.
                program = "const R=require('./scripts/research-engine.cjs'); console.log(JSON.stringify(R.quoteSpecs(process.argv[1],Number(process.argv[2]),{stake:Number(process.argv[3]),mult:Number(process.argv[4])})));"
                specs = json.loads(subprocess.check_output(["node", "-e", program, symbol, str(reference), str(stake), str(mult)], cwd=ROOT, text=True))
                records = []
                for spec in specs:
                    response = await request(spec["request"])
                    if response.get("error"):
                        records.append({"spec": spec, "capturedAt": int(time.time()), "error": {"code": response["error"].get("code"), "message": response["error"].get("message")}})
                    else:
                        # Proposal IDs and echo_req are not needed or stored.
                        p = response.get("proposal") or {}
                        records.append({"spec": spec, "capturedAt": int(time.time()), "response": {"proposal": {
                            key: p[key] for key in ("ask_price", "payout", "commission", "contract_details") if key in p}}})
                market["quotes"][label] = records
            output["markets"].append(market)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, separators=(",", ":")) + "\n")
    print(json.dumps({"output": str(path), "captured_utc": dt.datetime.fromtimestamp(output["captured_at"], dt.timezone.utc).isoformat(),
        "markets": [{"symbol": m["symbol"], "periods": len(m["periods"]), "ticks": sum(len(p["prices"]) for p in m["periods"]),
                     "proposal_errors": sum(bool(q.get("error")) for qs in m["quotes"].values() for q in qs)} for m in output["markets"]]}))


async def retry_unavailable(path):
    """Keep the frozen periods and successful quotes; retry only failed public reads."""
    output = json.loads(path.read_text())
    count = 0
    async with connect(PUBLIC, open_timeout=15) as socket:
        for market in output["markets"]:
            for records in market["quotes"].values():
                for row in records:
                    if not row.get("error"):
                        continue
                    count += 1
                    await socket.send(json.dumps({**row["spec"]["request"], "req_id": count}))
                    r = json.loads(await asyncio.wait_for(socket.recv(), 25))
                    row["capturedAt"] = int(time.time())
                    if r.get("error"):
                        row["error"] = {"code": r["error"].get("code"), "message": r["error"].get("message")}
                    else:
                        p = r.get("proposal") or {}
                        row.pop("error", None)
                        row["response"] = {"proposal": {key: p[key] for key in ("ask_price", "payout", "commission", "contract_details") if key in p}}
                    await asyncio.sleep(1.1)
    path.write_text(json.dumps(output, separators=(",", ":")) + "\n")
    print(json.dumps({"retried_public_quotes": count, "remaining_errors": sum(bool(q.get("error")) for m in output["markets"] for qs in m["quotes"].values() for q in qs)}))


async def refresh_history(path):
    """Refresh dated windows without wasting successful proposal reads."""
    output = json.loads(path.read_text())
    async with connect(PUBLIC, open_timeout=15) as socket:
        for market in output["markets"]:
            periods = []
            for old in market["periods"]:
                end = old["requested_end"]
                await socket.send(json.dumps({"ticks_history": market["symbol"], "start": end - 2000,
                    "end": str(end), "count": 1000, "style": "ticks"}))
                r = json.loads(await asyncio.wait_for(socket.recv(), 25))
                if r.get("error"):
                    raise RuntimeError("Public dated history unavailable")
                h = r.get("history") or {}
                times = h.get("times", [])
                if len(times) < 500 or times[0] < end - 2000 or times[-1] > end:
                    raise RuntimeError("Historical dates not verified; refusing overlapping/recent substitutes")
                periods.append({**old, "prices": list(map(float, h["prices"])), "times": times, "pip": int(r["pip_size"])})
                await asyncio.sleep(1.1)
            if any(periods[i]["times"][-1] >= periods[i + 1]["times"][0] for i in range(len(periods) - 1)):
                raise RuntimeError("Historical periods overlap")
            market["periods"] = periods
    path.write_text(json.dumps(output, separators=(",", ":")) + "\n")
    print(json.dumps({"dated_windows_verified": sum(len(m["periods"]) for m in output["markets"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "research" / "public-sample.json")
    parser.add_argument("--retry-unavailable", action="store_true")
    parser.add_argument("--refresh-history", action="store_true")
    args = parser.parse_args()
    asyncio.run(refresh_history(args.output) if args.refresh_history else retry_unavailable(args.output) if args.retry_unavailable else capture(args.output))
