"""Recovered scanner input and price anchors. No order methods or invented payouts."""
import asyncio
import base64
import contextlib
import io
import json
import math
import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path
import shutil
import time

from lib.deriv_demo import DemoError, amount

FRAMES = {86400: "D1", 14400: "H4", 3600: "H1", 900: "M15", 300: "M5", 60: "M1"}
ENTRY_FRAME = 60
SCAN_TIMEOUT = 45
WORKER = Path(__file__).resolve().parents[1] / "chartscanner/recovery/worker.ts"

AI_REASONS={"credentials":"API key or provider permissions rejected", "credits":"provider credits or billing unavailable",
    "quota_or_rate_limit":"provider quota or rate limit reached", "model_unavailable":"model unavailable",
    "request_rejected":"provider rejected the image/context request", "provider_unavailable":"provider unavailable",
    "output_limit":"model output limit reached", "empty_response":"model returned no readable answer",
    "no_vision_model":"no image-capable model found", "vision_probe_failed":"image-reading check failed",
    "invalid_json":"model returned invalid JSON", "timeout":"provider timed out", "network":"provider network request failed"}


class AnalysisFailure(DemoError):
    def __init__(self,code,details=None):
        self.code=code if code in {"ai_unavailable","analysis_failed","analysis_timeout","worker_failed","local_rules_failed"} else "worker_failed"
        self.details=[]
        for row in details if isinstance(details,list) else []:
            if isinstance(row,dict) and type(row.get("slot")) is int and 1<=row["slot"]<=6 and row.get("provider") in {"openai","gemini","openrouter"} and row.get("reason") in AI_REASONS:
                clean={k:row[k] for k in ("slot","provider","reason")}
                if clean not in self.details:self.details.append(clean)
        text="; ".join(f"slot {r['slot']} ({r['provider']}): {AI_REASONS[r['reason']]}" for r in self.details[:6])
        message=("AI analysis unavailable — "+text if text else
            "The local rule check exceeded its 45-second safety budget." if self.code=="analysis_timeout" else
            "AI analysis could not return a verified chart result. Check the configured vision models." if self.code in {"ai_unavailable","analysis_failed"} else
            "The local rule scanner could not run. Check its Node runtime and deployment.")
        super().__init__(message+" No new order was authorized.",503)


@lru_cache(maxsize=4)
def node_version(executable):
    try:
        result=subprocess.run([executable,"--version"],capture_output=True,text=True,check=True,timeout=2)
        version=result.stdout.strip()
        return version if re.fullmatch(r"v\d+\.\d+\.\d+",version) else None
    except (OSError,subprocess.SubprocessError):
        return None


def runtime_status():
    executable=shutil.which("node")
    version=node_version(executable) if executable else None
    return {"node_available":bool(version and version.split(".")[0]=="v24"),
        "node_version":version,"worker_available":WORKER.is_file()}


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise DemoError("Unverified market or contract value.", 502)
    try:
        result = float(value)
    except (ValueError, OverflowError):
        raise DemoError("Unverified market or contract value.", 502) from None
    if not math.isfinite(result):
        raise DemoError("Unverified market or contract value.", 502)
    return result


def closed_candles(raw, granularity, now, allow_gaps=False):
    if granularity not in FRAMES or not isinstance(raw, list):
        raise DemoError("Deriv candle history is unavailable.", 502)
    bars, last = [], -1
    boundary = int(now) // granularity * granularity
    for value in raw:
        epoch = value.get("epoch")
        if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch % granularity or epoch <= last:
            raise DemoError("Deriv candle times are inconsistent.", 502)
        last = epoch
        bar = {k: finite(value.get(k)) for k in ("open", "high", "low", "close")}
        if min(bar.values()) <= 0 or bar["low"] > min(bar["open"], bar["close"]) or bar["high"] < max(bar["open"], bar["close"]) or bar["low"] > bar["high"]:
            raise DemoError("Deriv returned invalid candles.", 502)
        if epoch < boundary:
            bars.append({"epoch": epoch, **bar})
    recent=bool(bars) and (bars[-1]["epoch"]==boundary-granularity or allow_gaps and granularity>=3600 and 0<boundary-bars[-1]["epoch"]<=4*86400)
    if len(bars) < 60 or not recent or not allow_gaps and any(b["epoch"]-a["epoch"] != granularity for a,b in zip(bars,bars[1:])):
        raise DemoError("Closed candle history is incomplete or stale. No entry was made.", 502)
    return bars[-160:]


def render_chart(symbol, granularity, bars):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1300, 720), "#080f1e")
    draw = ImageDraw.Draw(image)
    # Pillow's bundled default font avoids dependencies on system fonts.
    font = ImageFont.load_default(size=18)
    lo, hi = min(b["low"] for b in bars), max(b["high"] for b in bars)
    span = hi-lo or hi*.0001
    lo -= span*.05; hi += span*.05
    def y(price): return round(650-(price-lo)/(hi-lo)*550)
    draw.text((20,18), f"{symbol}  |  {FRAMES[granularity]}  |  DERIV CLOSED CANDLES  |  UTC", fill="white", font=font)
    draw.text((20,48), "Last closed candle: "+time.strftime("%Y-%m-%d %H:%M",time.gmtime(bars[-1]["epoch"])), fill="#8da9cd", font=font)
    for n in range(7):
        level = lo+(hi-lo)*n/6
        draw.line((30,y(level),1160,y(level)), fill="#26354c")
        draw.text((1170,y(level)-10),f"{level:.5f}",fill="white",font=font)
    for i,b in enumerate(bars):
        x = 36+i*1110/max(1,len(bars)-1)
        color = "#78b7ff" if b["close"] >= b["open"] else "#ed5661"
        draw.line((x,y(b["high"]),x,y(b["low"])),fill=color,width=1)
        draw.rectangle((x-2,min(y(b["open"]),y(b["close"])),x+2,max(y(b["open"]),y(b["close"]))), fill=color)
        if i % max(1,len(bars)//5)==0:
            draw.text((x-5,675),time.strftime("%d %b %H:%M",time.gmtime(b["epoch"])),fill="#8da9cd",font=font)
    buffer=io.BytesIO();image.save(buffer,format="PNG")
    return {"dataUrl":"data:image/png;base64,"+base64.b64encode(buffer.getvalue()).decode(),"mime":"image/png"}


async def scan(symbol, frames, prior=None):
    node = shutil.which("node")
    ready=runtime_status()
    if not ready["node_available"] or not ready["worker_available"]:
        raise DemoError("The local scanner requires Node 24 and its bundled rule files.", 503)
    payload=json.dumps({"symbol":symbol,"frames":frames}).encode()
    process=await asyncio.create_subprocess_exec(node,str(WORKER),stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
    try:
        stdout,_=await asyncio.wait_for(process.communicate(payload),SCAN_TIMEOUT)
    except BaseException as exc:
        with contextlib.suppress(ProcessLookupError): process.kill()
        await process.wait()
        if isinstance(exc,TimeoutError):raise AnalysisFailure("analysis_timeout") from None
        raise
    if len(stdout)>1_000_000:
        raise DemoError("The analysis response exceeded its limit.",502)
    try:
        data=json.loads(stdout)
        if not isinstance(data,dict):raise ValueError
        if process.returncode or data.get("ok") is not True:
            raise AnalysisFailure(data.get("error_code"),data.get("attempts"))
        if not isinstance(data.get("result"),dict):raise ValueError
        return data["result"]
    except (ValueError,TypeError):
        raise AnalysisFailure("worker_failed") from None


def anchor(value, frames):
    if not isinstance(value,dict) or value.get("field") not in {"open","high","low","close"}:
        raise DemoError("The setup has no verified candle anchor.",409)
    g,epoch=value.get("granularity"),value.get("epoch")
    if isinstance(g,bool) or isinstance(epoch,bool) or not isinstance(g,int) or not isinstance(epoch,int):
        raise DemoError("The setup has no verified candle anchor.",409)
    bar=next((b for b in frames.get(g,[]) if b["epoch"]==epoch),None)
    if not bar: raise DemoError("The setup cites an unseen or unfinished candle.",409)
    return bar[value["field"]]


def price_plan(result, symbol, frames, pip):
    audit=result.get("policy_audit") or {}
    verdict=result.get("verdict")
    plan=result.get("multiplier_plan")
    if verdict not in {"BUY_NOW","SELL_NOW"} or audit.get("version")!="original-evidence-v1" or audit.get("conflicts") is not False or audit.get("agreeing_entry_strategies",0)<2 or audit.get("confirmations",0)<3 or not isinstance(plan,dict):
        raise DemoError("WAIT — the recovered rules do not support a complete immediate entry.",409)
    if result.get("pair")!=symbol or plan.get("direction") != verdict.split("_")[0]:
        raise DemoError("The chart interpretation does not match this account's market/direction.",409)
    votes={r["strategy_id"] for r in result.get("strategy_evaluations",[]) if r.get("status")=="match" and not r.get("missing_conditions")}
    entry_sources={"structure-first","carlfx-blueprint","eagle-way","fstraders","giant-killer","candle-range-theory","opom","pabifx-domain","wcfx-snd","lesson2-tactics","lesson3-tactics","lesson3-engulfing","lesson4-htf-range"}
    sources=set(plan.get("source_strategy_ids",[])) & votes & entry_sources if isinstance(plan.get("source_strategy_ids"),list) else set()
    explicit_exits={"structure-first","candle-range-theory","wcfx-snd","lesson2-tactics","lesson4-htf-range"}
    if len(sources)<2 or not sources & explicit_exits:
        raise DemoError("The entry plan is missing strategy provenance.",409)
    low,high=anchor(plan.get("entry_low"),frames),anchor(plan.get("entry_high"),frames)
    if not isinstance(pip,int) or isinstance(pip,bool) or not 0<=pip<=8:
        raise DemoError("Deriv price precision is unverified.",502)
    tick=10**-pip
    stop=anchor(plan.get("stop_anchor"),frames)+( -tick if plan["direction"]=="BUY" else tick)
    target=anchor(plan.get("target_anchor"),frames)
    if not (stop<low<=high<target if plan["direction"]=="BUY" else target<low<=high<stop):
        raise DemoError("The documented entry, stop and target are inconsistent.",409)
    return {"direction":plan["direction"],"low":low,"high":high,"stop":stop,"target":target,"pip":pip}


def quote_limits(proposal, plan, stake, multiplier):
    spot,commission=finite(proposal.get("spot")),finite(proposal.get("commission"))
    if not plan["low"]<=spot<=plan["high"] or spot<=0 or commission<0 or amount(proposal.get("ask_price"))!=stake:
        raise DemoError("WAIT — the current Deriv quote is outside the recovered entry zone.",409)
    sign=1 if plan["direction"]=="BUY" else -1
    gain=amount(stake*multiplier*sign*(plan["target"]-spot)/spot-commission)
    loss=amount(-stake*multiplier*sign*(plan["stop"]-spot)/spot+commission)
    params=proposal.get("validation_params") or {}
    for kind,value in (("take_profit",gain),("stop_loss",loss)):
        limits=params.get(kind) or {}
        if not finite(limits.get("min"))<=value<=finite(limits.get("max")) or value<=0:
            raise DemoError("WAIT — this source-defined exit is outside Deriv's supported contract limits.",409)
    if loss>stake:
        raise DemoError("WAIT — the source stop lies beyond this contract's stake risk.",409)
    return {"stop_loss":loss,"take_profit":gain}


def verify_final_quote(q, plan, stake, multiplier, limits, now):
    # A second authenticated quote can move; its actual provider barriers must
    # still agree with the source levels to within monetary/price quantization.
    spot=finite(q.get("spot"))
    if not q.get("id") or amount(q.get("ask_price"))!=stake or q.get("multiplier")!=multiplier or not plan["low"]<=spot<=plan["high"] or not 0<=now-finite(q.get("spot_time"))<=10:
        raise DemoError("The final authenticated quote is stale or does not match the setup.",409)
    orders=q.get("limit_order") or {}
    tolerance=spot/(stake*multiplier)*.011+10**-plan["pip"]
    for name,level in (("stop_loss",plan["stop"]),("take_profit",plan["target"])):
        order=orders.get(name) or {}
        if abs(abs(finite(order.get("order_amount")))-limits[name])>.000001 or abs(finite(order.get("value"))-level)>tolerance:
            raise DemoError("The provider's quoted exits no longer match the source setup.",409)
    return q
