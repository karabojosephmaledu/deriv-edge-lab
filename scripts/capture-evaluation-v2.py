"""Capture predeclared, previously uninspected PUBLIC history only. No account access."""
import asyncio
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import time

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("public_capture", ROOT / "scripts/capture-research.py")
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)


def checked_page(response, symbol, start, end):
    if response.get("error"):
        raise ValueError("Public history request failed; no substitute data allowed")
    h = response.get("history") or {}
    times, prices = h.get("times", []), h.get("prices", [])
    if len(times) != 1000 or len(prices) != 1000 or times[0] != start + 2 or times[-1] != end:
        raise ValueError("Provider history did not match the declared evaluation interval")
    if any(times[i] - times[i - 1] != 2 for i in range(1, len(times))):
        raise ValueError("Historical gap or duplicate; evaluation rejected")
    prices = list(map(float, prices))
    if not all(math.isfinite(p) and p > 0 for p in prices):
        raise ValueError("Invalid public price")
    pip = response["pip_size"]
    if not isinstance(pip, (int, float)) or isinstance(pip, bool) or pip != int(pip) or not 0 <= pip <= 10:
        raise ValueError("Invalid public precision")
    return {"symbol": symbol, "prices": prices, "times": times, "pip": int(pip)}


async def capture():
    frozen_paths = ["frontend/public/research.js", "research/protocol-v2.json", "scripts/evaluate-v2.cjs", "scripts/capture-evaluation-v2.py"]
    subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *frozen_paths], cwd=ROOT, check=True)
    if any(subprocess.check_output(["git", "ls-files", "--", p], cwd=ROOT, text=True).strip() != p for p in frozen_paths):
        raise ValueError("Commit protocol, engine and evaluation scripts before collecting data")
    protocol_bytes = (ROOT / "research/protocol-v2.json").read_bytes()
    protocol = json.loads(protocol_bytes)
    old = json.loads((ROOT / "research/public-sample.json").read_text())
    output = {"captured_at": int(time.time()), "frozen_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "protocol_sha256": hashlib.sha256(protocol_bytes).hexdigest(),
              "engine_sha256": hashlib.sha256((ROOT / "frontend/public/research.js").read_bytes()).hexdigest(),
              "source": CAPTURE.PUBLIC, "role": "Previously uninspected historical evaluation, not a prospective forward test", "periods": []}
    seq = 0
    async with connect(CAPTURE.PUBLIC, open_timeout=15, max_size=4 * 1024 * 1024) as socket:
        for symbol in protocol["markets"]:
            for stamp in protocol["evaluation_windows_utc"]:
                beginning = int(dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())
                ending = beginning + 2 * protocol["ticks_per_window"]
                previous = next(m for m in old["markets"] if m["symbol"] == symbol)
                if any(beginning <= p["times"][-1] and ending >= p["times"][0] for p in previous["periods"]):
                    raise ValueError("Evaluation overlaps inspected development data")
                data = {"symbol": symbol, "prices": [], "times": [], "pip": None}
                for j in range(protocol["ticks_per_window"] // 1000):
                    start, end = beginning + j * 2000, beginning + (j + 1) * 2000
                    seq += 1
                    payload = CAPTURE.public_payload({"ticks_history": symbol, "count": 1000, "start": start, "end": str(end), "style": "ticks"})
                    await socket.send(json.dumps({**payload, "req_id": seq}))
                    while True:
                        response = json.loads(await asyncio.wait_for(socket.recv(), 25))
                        if response.get("req_id") == seq:
                            break
                    chunk = checked_page(response, symbol, start, end)
                    if data["pip"] is not None and chunk["pip"] != data["pip"]:
                        raise ValueError("Precision changed across pages")
                    data["prices"].extend(chunk["prices"]); data["times"].extend(chunk["times"]); data["pip"] = chunk["pip"]
                    await asyncio.sleep(1.1)
                output["periods"].append(data)
    blob = gzip.compress(json.dumps(output, separators=(",", ":")).encode(), mtime=0)
    path = ROOT / "research/unseen-v2.json.gz"
    path.write_bytes(blob)
    print(json.dumps({"output": str(path), "frozen_commit": output["frozen_commit"], "periods": len(output["periods"]), "observations": sum(len(d["prices"]) for d in output["periods"]), "sha256": hashlib.sha256(blob).hexdigest()}))


if __name__ == "__main__":
    asyncio.run(capture())
