"""Controlled virtual provider responses only. Never opens a broker socket."""
import asyncio
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
from tests.test_demo_execution import Collection,DEMO,REAL,TOKEN,ORIGIN
from lib.deriv_demo import DemoError,DemoRejected,Session,INSTANCE
from lib.chart_strategy import FRAMES,closed_candles,price_plan,quote_limits,verify_final_quote,render_chart
from lib import chart_strategy
from routers import chart_auto,deriv
from routers.chart_auto import AutoConfig,Run,Runtime,execution_url


def configuration(**patch):
    return AutoConfig(**{"account_id":"DOT-test","mode":"demo","symbol":"R_100","stake":10.0,"target":20.0,"max_loss":20.0,**patch})


def frames(now=None):
    now=now or time.time()
    return {g:[{"epoch":int(now)//g*g-g*(160-i),"open":99.5,"low":99.0,"high":105.0,"close":101.0} for i in range(160)] for g in FRAMES}


def analysis(data):
    epoch=data[900][-1]["epoch"]
    def point(field):return {"granularity":900,"epoch":epoch,"field":field}
    return {"pair":"R_100","verdict":"BUY_NOW","policy_audit":{"version":"original-evidence-v1","conflicts":False,"agreeing_entry_strategies":2,"confirmations":4},
        "strategy_evaluations":[{"strategy_id":s,"status":"match","missing_conditions":[]} for s in ["structure-first","candle-range-theory"]],
        "multiplier_plan":{"direction":"BUY","entry_low":point("low"),"entry_high":point("close"),"stop_anchor":point("low"),"target_anchor":point("high"),"source_strategy_ids":["structure-first","candle-range-theory"]}}


class Channel:
    def __init__(self,kind,*callbacks):self.kind=kind;self.calls=[];self.closed=False;self.profit=3.17;self.fail_buy=False;self.reject=False;self.bad_quote=False
    async def open(self,url):self.url=execution_url(url,self.kind)
    async def close(self):self.closed=True
    async def request(self,q):
        self.calls.append(copy.deepcopy(q))
        if "balance" in q:return {"balance":{"balance":1000,"currency":"USD"}}
        if "portfolio" in q:return {"portfolio":{"contracts":[]}}
        if "contracts_for" in q:return {"contracts_for":{"available":[{"contract_type":"MULTUP","underlying_symbol":"R_100","multiplier_range":[40,100]}]}}
        if "proposal" in q:
            p={"id":"controlled-quote","spot":100.0,"spot_time":int(time.time()),"commission":.2,"ask_price":10.0,"multiplier":40,
                "validation_params":{"stop_loss":{"min":.1,"max":10},"take_profit":{"min":.1,"max":100}}}
            if q.get("limit_order"):
                l=q["limit_order"];p["limit_order"]={"stop_loss":{"order_amount":-l["stop_loss"],"value":100*(1-(l["stop_loss"]-.2)/400)},"take_profit":{"order_amount":l["take_profit"],"value":100*(1+(l["take_profit"]+.2)/400)}}
                if self.bad_quote:p["limit_order"]["stop_loss"]["value"]=80
            return {"proposal":p}
        if "buy" in q:
            if self.reject:raise DemoRejected("controlled rejection")
            if self.fail_buy:raise DemoError("controlled lost response",502)
            return {"buy":{"contract_id":123,"buy_price":10}}
        if "proposal_open_contract" in q:return {"proposal_open_contract":{"contract_id":123,"is_sold":1,"profit":self.profit,"buy_price":10,"sell_price":10+self.profit,"sell_time":time.time()}}
        return {}


class Broker:
    def __init__(self):
        self.db=SimpleNamespace(demo_account_locks=Collection(),chart_orders=Collection(),chart_runs=Collection());self.sessions={};self.accounts=[copy.deepcopy(DEMO),copy.deepcopy(REAL)]
    async def list_accounts(self,s):return self.accounts
    async def rest(self,s,method,path):
        kind="real" if "ROT-test" in path else "demo"
        return {"data":{"url":"wss://api.derivws.com/trading/v1/options/ws/"+kind+"?otp=controlled-one-time-value"}}


@pytest.fixture(autouse=True)
def enabled(monkeypatch):
    for key,value in {"CHART_AUTOTRADING_ENABLED":"true","DERIV_DEMO_TRADING_ENABLED":"true","CHART_AI_SLOT_1_API_KEY":"controlled-key-never-persist","CHART_AI_SLOT_1_PROVIDER":"openai"}.items():monkeypatch.setenv(key,value)
    monkeypatch.delenv("DERIV_LIVE_TRADING_ENABLED",raising=False)


def setup(**patch):
    b=Broker();s=Session(TOKEN,"oauth",time.time()+3600,ORIGIN);b.sessions[s.sid]=s
    async def catalog():return [{"symbol":code,"name":code,"supported":True,"open":True,"market":"synthetic_index"} for code in ["R_100","R_25","frxXAUUSD","cryBTCUSD"]]
    rt=Runtime(b,Channel,market_loader=catalog);r=Run("controlled-run",configuration(**patch),s,Channel(patch.get("mode","demo")))
    r.tick={"epoch":int(time.time()),"received":time.monotonic(),"pip":2}
    b.db.demo_account_locks.rows[r.cfg.account_id]={"_id":r.cfg.account_id,"order_id":r.id,"state":"chart-scanning","instance":INSTANCE}
    b.db.chart_runs.rows[r.id]={"_id":r.id,"instance":INSTANCE}
    rt.runs[s.sid]=r
    return rt,s,r


@pytest.mark.parametrize("patch",[{"stake":0.0},{"stake":float("nan")},{"stake":.9},{"max_loss":9.0},{"stake":10.001},{"mode":"real"},{"symbol":"forged"}])
def test_invalid_configuration(patch):
    with pytest.raises(ValidationError):configuration(**patch)


@pytest.mark.parametrize("url,kind",[("wss://api.derivws.com/trading/v1/options/ws/real?otp=x","demo"),("wss://evil.test/trading/v1/options/ws/demo?otp=x","demo"),("ws://api.derivws.com/trading/v1/options/ws/demo?otp=x","demo"),("wss://api.derivws.com/trading/v1/options/ws/demo?otp=x&extra=y","demo")])
def test_socket_account_type_host_and_otp_are_checked(url,kind):
    with pytest.raises(DemoError):execution_url(url,kind)


def test_both_official_socket_types_are_supported_independently():
    for kind in ["demo","real"]:assert execution_url("wss://api.derivws.com/trading/v1/options/ws/"+kind+"?otp=x",kind)


def test_only_closed_contiguous_actual_candles_are_used():
    now=time.time();data=frames(now)[900];boundary=int(now)//900*900
    raw=data+[{**data[-1],"epoch":boundary,"close":100}]
    assert closed_candles(raw,900,now)==data
    for bad in [data[:-1],data[:20]+data[21:],[{**data[0],"high":1}]+data[1:],data+[data[-1]]]:
        with pytest.raises(DemoError):closed_candles(bad,900,now)


def test_rendered_image_contains_actual_candles_and_not_a_synthetic_wallet():
    result=render_chart("R_100",900,frames()[900]);assert result["mime"]=="image/png";assert result["dataUrl"].startswith("data:image/png;base64,iVBOR")


def test_price_plan_uses_provider_ohlc_anchors_not_model_prices():
    f=frames();a=analysis(f);p=price_plan(a,"R_100",f,2)
    assert p["stop"]==98.99 and p["target"]==105 and p["low"]==99
    a["multiplier_plan"]["invented_price"]=9999
    assert price_plan(a,"R_100",f,2)==p
    a["multiplier_plan"]["stop_anchor"]["epoch"]+=900
    with pytest.raises(DemoError):price_plan(a,"R_100",f,2)


@pytest.mark.parametrize("change",["WAIT","other_symbol","opposite_direction","missing_provenance","missing_exit_rules"])
def test_incomplete_or_incompatible_setups_do_not_authorize_quotes(change):
    f=frames();a=analysis(f)
    if change=="WAIT":a["verdict"]="WAIT"
    if change=="other_symbol":a["pair"]="EURUSD"
    if change=="opposite_direction":a["multiplier_plan"]["direction"]="SELL"
    if change=="missing_provenance":a["multiplier_plan"]["source_strategy_ids"]=[]
    if change=="missing_exit_rules":
        for e in a["strategy_evaluations"]:e["strategy_id"]="eagle-way"
        a["multiplier_plan"]["source_strategy_ids"]=["eagle-way","giant-killer"]
    with pytest.raises(DemoError):price_plan(a,"R_100",f,2)


@pytest.mark.asyncio
async def test_quote_uses_actual_commission_and_provider_exit_ranges():
    f=frames();p=price_plan(analysis(f),"R_100",f,2);channel=Channel("demo")
    q=(await channel.request({"proposal":1}))["proposal"];limits=quote_limits(q,p,10,40)
    assert limits=={"stop_loss":4.24,"take_profit":19.8}
    final=(await channel.request({"proposal":1,"limit_order":limits}))["proposal"]
    assert verify_final_quote(final,p,10,40,limits,time.time())==final
    final["limit_order"]["stop_loss"]["value"]=90
    with pytest.raises(DemoError):verify_final_quote(final,p,10,40,limits,time.time())
    q["validation_params"]["take_profit"]["max"]=1
    with pytest.raises(DemoError):quote_limits(q,p,10,40)


@pytest.mark.asyncio
async def test_only_provider_settlement_changes_session_pl_never_estimated_target():
    rt,s,r=setup();f=frames();await rt.entry(r,f,analysis(f))
    assert r.net==3.17 and r.history[0]["profit"]==3.17
    assert [q["price"] for q in r.channel.calls if "buy" in q]==[10.0]
    assert r.pending is None and not r.unresolved
    assert rt.db.demo_account_locks.rows[r.cfg.account_id]["state"]=="chart-scanning"
    assert TOKEN not in json.dumps(r.public()) and s.sid not in json.dumps(r.public())


@pytest.mark.asyncio
async def test_stake_remains_fixed_after_a_loss():
    rt,s,r=setup();f=frames();r.channel.profit=-10
    await rt.entry(r,f,analysis(f));assert r.net==-10 and r.cfg.stake==10
    assert r.history[0]["status"]=="loss"
    # A fresh session has independent history and no copied results.
    new=Run("next",configuration(),s);assert new.history==[] and new.net==0


@pytest.mark.parametrize("state,net",[("paused",0),("stopped",0),("running",20),("running",-20),("running",-15)])
@pytest.mark.asyncio
async def test_pause_stop_and_session_limits_block_entry(state,net):
    rt,s,r=setup();r.status=state;r.net=net;f=frames();await rt.entry(r,f,analysis(f))
    assert not any("buy" in q or "proposal" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_limit_reached_while_paused_cannot_resume():
    rt,s,r=setup();r.status="paused";r.net=20
    result=await rt.control(s,r.id,"resume");assert result["status"]=="stopped"


@pytest.mark.asyncio
async def test_expired_or_disconnected_authorization_blocks_all_orders():
    rt,s,r=setup();rt.broker.sessions.pop(s.sid);f=frames()
    with pytest.raises(DemoError):await rt.entry(r,f,analysis(f))
    assert r.channel.calls==[]


@pytest.mark.asyncio
async def test_actual_real_account_requires_separate_server_enable(monkeypatch):
    rt,s,r=setup(mode="real",account_id="ROT-test",acknowledge_live=True);f=frames()
    with pytest.raises(DemoError):await rt.entry(r,f,analysis(f))
    assert r.channel.calls==[]
    monkeypatch.setenv("DERIV_LIVE_TRADING_ENABLED","true")
    await rt.entry(r,f,analysis(f));assert r.net==3.17
    # This is a virtual stub; no network sockets or real trades occur in this test.


@pytest.mark.asyncio
async def test_live_flag_cannot_override_account_type_mismatch(monkeypatch):
    monkeypatch.setenv("DERIV_LIVE_TRADING_ENABLED","true")
    rt,s,r=setup(mode="real",account_id="DOT-test",acknowledge_live=True);f=frames()
    with pytest.raises(DemoError):await rt.entry(r,f,analysis(f))
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_lost_buy_receipt_keeps_lock_and_is_never_retried():
    rt,s,r=setup();r.channel.fail_buy=True;f=frames()
    with pytest.raises(DemoError):await rt.entry(r,f,analysis(f))
    assert r.unresolved and r.status=="stopped"
    await rt.entry(r,f,analysis(f))
    assert len([q for q in r.channel.calls if "buy" in q])==1
    assert rt.db.demo_account_locks.rows[r.cfg.account_id]["state"]=="chart-ordering"


@pytest.mark.asyncio
async def test_bad_final_exit_quote_prevents_buy():
    rt,s,r=setup();r.channel.bad_quote=True;f=frames()
    with pytest.raises(DemoError):await rt.entry(r,f,analysis(f))
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_database_write_failure_prevents_buy():
    rt,s,r=setup();rt.db.chart_orders.fail_insert=True;f=frames()
    with pytest.raises(RuntimeError):await rt.entry(r,f,analysis(f))
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_ownership_change_prevents_buy():
    rt,s,r=setup();rt.db.demo_account_locks.rows[r.cfg.account_id]["instance"]="other-process";f=frames()
    with pytest.raises(DemoError):await rt.entry(r,f,analysis(f))
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_actual_session_history_is_not_duplicated_on_repeated_settlement():
    rt,s,r=setup();f=frames();await rt.entry(r,f,analysis(f))
    order=next(iter(rt.db.chart_orders.rows.values()))
    await rt.monitor(r,order);assert r.net==3.17 and len(r.history)==1


def test_chart_endpoints_reuse_existing_server_session_and_csrf(monkeypatch):
    from server import app
    b=Broker();s=Session(TOKEN,"oauth",time.time()+3600,ORIGIN);b.sessions[s.sid]=s
    monkeypatch.setattr(deriv,"_broker",b)
    client=TestClient(app);client.cookies.set("deriv_demo_session",s.sid)
    assert client.post("/api/deriv/chart/start",json=configuration().model_dump(),headers={"Origin":ORIGIN}).status_code==403
    assert client.post("/api/deriv/chart/control",json={"run_id":"x","action":"stop"},headers={"Origin":"https://evil.test","X-Deriv-CSRF":s.csrf}).status_code==403
    assert client.get("/api/deriv/chart/status").status_code==200


def interrupted(*,state="open",age=600,run_status="stopped"):
    rt,s,r=setup()
    rt.runs.clear()
    rt.db.demo_account_locks.rows[r.cfg.account_id].update(instance="retired-process",state="chart-ordering" if state in {"open","ordering"} else "chart-scanning")
    rt.db.chart_runs.rows[r.id].update(config=r.cfg.model_dump(),account_id=r.cfg.account_id,status=run_status,created_at=time.time()-age,updated_at=time.time()-age)
    if state in {"open","ordering"}:
        order={"_id":"persisted-order","id":"persisted-order","run_id":r.id,"account_id":r.cfg.account_id,"status":state,"contract_id":123 if state=="open" else None,"stake":10.0,"opened_at":time.time()-age,"direction":"BUY","multiplier":40}
        rt.db.chart_orders.rows[order["id"]]=order
    return rt,s,r


@pytest.mark.asyncio
async def test_restart_recovers_actual_settlement_without_buying_or_resuming():
    rt,s,old=interrupted()
    result=await rt.recover(s,old.cfg.account_id)
    recovered=rt.runs[s.sid];await recovered.task
    assert result["status"]=="stopped" and recovered.status=="stopped"
    assert recovered.net==3.17 and recovered.history[0]["contract_id"]==123
    assert not any("buy" in q or "proposal" in q for q in recovered.channel.calls)
    assert rt.db.demo_account_locks.rows[old.cfg.account_id]["state"]=="idle"


@pytest.mark.parametrize("status",["running","paused","stopped"])
@pytest.mark.asyncio
async def test_recent_owner_lease_blocks_recovery_even_after_stop(status):
    rt,s,old=interrupted(age=30,run_status=status)
    with pytest.raises(DemoError,match="five-minute"):await rt.recover(s,old.cfg.account_id)
    assert rt.db.demo_account_locks.rows[old.cfg.account_id]["instance"]=="retired-process"


@pytest.mark.asyncio
async def test_unknown_purchase_is_not_cleared_or_retried_after_restart():
    rt,s,old=interrupted(state="ordering")
    with pytest.raises(DemoError,match="unknown outcome"):await rt.recover(s,old.cfg.account_id)
    assert rt.db.demo_account_locks.rows[old.cfg.account_id]["state"]=="chart-ordering"
    assert not rt.runs


@pytest.mark.asyncio
async def test_interrupted_analysis_releases_only_after_monitoring_recovery():
    rt,s,old=interrupted(state="chart-scanning")
    await rt.recover(s,old.cfg.account_id);r=rt.runs[s.sid];await r.task
    assert r.history==[] and r.net==0 and r.status=="stopped"
    assert not any("buy" in q for q in r.channel.calls)
    assert rt.db.demo_account_locks.rows[old.cfg.account_id]["state"]=="idle"


@pytest.mark.asyncio
async def test_start_cannot_steal_another_process_account_lock():
    rt,s,old=interrupted()
    with pytest.raises(DemoError,match="active or unresolved"):await rt.start(s,old.cfg)
    assert rt.db.demo_account_locks.rows[old.cfg.account_id]["instance"]=="retired-process"


@pytest.mark.asyncio
async def test_pausing_while_ai_is_running_prevents_a_late_entry():
    entered=asyncio.Event();release=asyncio.Event()
    rt,s,r=setup();f=frames()
    async def analyze(*args):entered.set();await release.wait();return analysis(f)
    async def read_frames(*args):return f
    rt.analyze=analyze;rt.frames=read_frames
    r.task=asyncio.create_task(rt.loop(r))
    await asyncio.wait_for(entered.wait(),1)
    await rt.control(s,r.id,"pause");release.set();await asyncio.sleep(.01)
    assert not any("buy" in q for q in r.channel.calls)
    r.task.cancel();await asyncio.gather(r.task,return_exceptions=True)


@pytest.mark.asyncio
async def test_monitor_heartbeat_prevents_a_long_contract_being_mistaken_for_dead():
    rt,s,r=setup();f=frames();await rt.entry(r,f,analysis(f))
    saved=rt.db.chart_runs.rows[r.id]
    assert saved["updated_at"]>time.time()-3 and r.heartbeat>0


@pytest.mark.parametrize("action",["pause","stop"])
@pytest.mark.asyncio
async def test_pause_or_stop_during_delayed_quote_blocks_the_buy(action):
    rt,s,r=setup();f=frames();entered=asyncio.Event();release=asyncio.Event()
    original=r.channel.request
    async def delayed(q):
        if q.get("proposal") and q.get("limit_order"):entered.set();await release.wait()
        return await original(q)
    r.channel.request=delayed
    task=asyncio.create_task(rt.entry(r,f,analysis(f)))
    await asyncio.wait_for(entered.wait(),1)
    await asyncio.wait_for(rt.control(s,r.id,action),1);release.set();await task
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.parametrize("action",["pause","stop"])
@pytest.mark.asyncio
async def test_pause_during_durable_order_intent_still_prevents_the_buy(action):
    rt,s,r=setup();f=frames();entered=asyncio.Event();release=asyncio.Event()
    original=rt.db.demo_account_locks.find_one_and_update
    async def delayed(query,update,**kwargs):
        result=await original(query,update,**kwargs)
        if update["$set"].get("state")=="chart-ordering":entered.set();await release.wait()
        return result
    rt.db.demo_account_locks.find_one_and_update=delayed
    task=asyncio.create_task(rt.entry(r,f,analysis(f)))
    await asyncio.wait_for(entered.wait(),1)
    await rt.control(s,r.id,action);release.set();await task
    assert not any("buy" in q for q in r.channel.calls)
    assert not r.pending and not r.unresolved
    assert next(iter(rt.db.chart_orders.rows.values()))["status"]=="not_sent"


@pytest.mark.parametrize("version,available",[("v22.22.0",False),("v24.22.1",True),("v26.0.0",False)])
def test_runtime_checks_the_actual_supported_node_major(monkeypatch,version,available):
    chart_strategy.node_version.cache_clear()
    monkeypatch.setattr(chart_strategy.shutil,"which",lambda _:"/controlled/node")
    monkeypatch.setattr(chart_strategy.subprocess,"run",lambda *a,**kw:SimpleNamespace(stdout=version+"\n"))
    try:
        result=chart_strategy.runtime_status()
        assert result["node_version"]==version and result["node_available"] is available
    finally:chart_strategy.node_version.cache_clear()


def test_missing_node_is_not_reported_as_ready(monkeypatch):
    monkeypatch.setattr(chart_strategy.shutil,"which",lambda _:None)
    result=chart_strategy.runtime_status()
    assert result["node_version"] is None and not result["node_available"]


def test_missing_bundled_worker_blocks_start_before_any_order(monkeypatch,tmp_path):
    monkeypatch.setattr(chart_strategy,"WORKER",tmp_path/"missing.ts")
    assert chart_auto.flags()["worker_available"] is False
    with pytest.raises(DemoError,match="bundled.*scanner"):chart_auto.require_enabled(configuration())


def test_render_backend_only_checkout_contains_a_loadable_original_worker(tmp_path):
    # Render rootDir=backend excludes all sibling directories. Reproduce that
    # exact packaging instead of relying on the whole developer workspace.
    backend=Path(__file__).resolve().parents[1]
    isolated=tmp_path/"backend"
    shutil.copytree(backend,isolated,ignore=shutil.ignore_patterns("__pycache__",".pytest_cache",".env","tests"))
    env={**os.environ,"PYTHONPATH":str(isolated)}
    for key in list(env):
        if key.startswith("CHART_AI_SLOT_"):env.pop(key)
    result=subprocess.run([sys.executable,"-c",'from lib.chart_strategy import WORKER,runtime_status; import subprocess; assert runtime_status()["node_available"]; assert WORKER.is_file(); r=subprocess.run(["node",str(WORKER)],input=\'{"images":[]}\',text=True,capture_output=True); assert r.returncode==1 and "error_code" in r.stdout; print("backend-only worker import passed")'],
        cwd=isolated,env=env,capture_output=True,text=True,timeout=10)
    assert result.returncode==0,result.stderr
    assert "backend-only worker import passed" in result.stdout


def test_scalping_uses_m1_m5_context_and_a_bounded_analysis_budget():
    assert chart_strategy.ENTRY_FRAME==60 and {60,300,900,3600,14400,86400}==set(FRAMES)
    assert chart_strategy.SCAN_TIMEOUT==45


def test_provider_diagnostics_keep_only_whitelisted_safe_fields():
    exc=chart_strategy.AnalysisFailure("ai_unavailable",[
        {"slot":1,"provider":"gemini","reason":"quota_or_rate_limit","raw":"private-key-canary"},
        {"slot":2,"provider":"openrouter","reason":"credits"},
        {"slot":3,"provider":"private-key-canary","reason":"unknown"}])
    assert "quota" in str(exc) and "credits" in str(exc)
    assert "private-key-canary" not in str(exc)+json.dumps(exc.details)
    assert len(exc.details)==2


@pytest.mark.asyncio
async def test_safe_ai_failure_is_visible_and_cannot_create_a_trade():
    rt,s,r=setup();f=frames()
    async def read_frames(*args):return f
    async def fail(*args):raise chart_strategy.AnalysisFailure("ai_unavailable",[{"slot":1,"provider":"gemini","reason":"credentials"}])
    rt.frames=read_frames;rt.analyze=fail
    await rt.loop(r)
    assert r.status=="stopped" and r.phase=="error" and r.error_code=="ai_unavailable"
    assert "slot 1 (gemini)" in r.error and "permissions rejected" in r.error
    assert not r.history and not r.pending and r.net==0
    assert not any("buy" in q for q in r.channel.calls)
    assert rt.db.chart_runs.rows[r.id]["error_code"]=="ai_unavailable"


@pytest.mark.asyncio
async def test_unexpected_analysis_error_does_not_echo_exception_secrets():
    rt,s,r=setup();f=frames()
    async def read_frames(*args):return f
    async def fail(*args):raise RuntimeError("private-key-canary")
    rt.frames=read_frames;rt.analyze=fail
    await rt.loop(r)
    assert r.error_code=="server_error" and "analysing" in r.error
    assert "private-key-canary" not in json.dumps(r.public())


@pytest.mark.asyncio
async def test_market_history_is_loaded_once_per_closed_minute_not_every_poll(monkeypatch):
    rt,s,r=setup();f=frames();calls=[];sleeps=[];original=asyncio.sleep
    async def read_frames(*args):calls.append("frames");return f
    async def analyze(*args):calls.append("analysis");return {"verdict":"WAIT"}
    async def bounded_sleep(delay):
        sleeps.append(delay)
        if len(sleeps)==3:r.status="stopped"
        await original(0)
    rt.frames=read_frames;rt.analyze=analyze
    monkeypatch.setattr(chart_auto.asyncio,"sleep",bounded_sleep)
    await rt.loop(r)
    assert calls==["frames","analysis"]
    assert r.last_check_at and r.next_check_at-r.last_check_at<=60
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_open_contract_phase_only_appears_after_provider_acknowledgement():
    rt,s,r=setup();f=frames();original=r.channel.request;observed=[]
    async def record(q):
        observed.append((next(iter(q)),r.phase))
        return await original(q)
    r.channel.request=record;await rt.entry(r,f,analysis(f))
    assert ("buy","ordering") in observed and ("proposal_open_contract","contract_open") in observed
    assert r.history[0]["profit"]==3.17 and r.phase=="waiting"


@pytest.mark.asyncio
async def test_scalping_signal_that_expires_during_quoting_cannot_buy():
    rt,s,r=setup();f=frames();original=r.channel.request
    async def delayed(q):
        response=await original(q)
        if q.get("proposal") and q.get("limit_order"):f[60][-1]["epoch"]-=60
        return response
    r.channel.request=delayed;await rt.entry(r,f,analysis(f))
    assert not any("buy" in q for q in r.channel.calls)
    assert r.phase=="waiting" and "next M1 candle" in r.note


def test_local_mode_requires_no_ai_key(monkeypatch):
    for i in range(1,7):monkeypatch.delenv(f"CHART_AI_SLOT_{i}_API_KEY",raising=False)
    chart_auto.require_enabled(configuration())
    assert chart_auto.flags()["analysis_engine"]=="local_rules" and not chart_auto.flags()["ai_required"]


@pytest.mark.parametrize("symbols",[[],["R_100","R_100"],["forged"],["R_100"]*17])
def test_invalid_watchlists_are_rejected(symbols):
    with pytest.raises(ValidationError):configuration(symbols=symbols)


def test_watchlist_and_original_single_symbol_are_compatible():
    assert configuration().symbols==["R_100"]
    cfg=configuration(symbols=["frxXAUUSD","cryBTCUSD"])
    assert cfg.symbol=="frxXAUUSD" and cfg.symbols==["frxXAUUSD","cryBTCUSD"]


@pytest.mark.asyncio
async def test_rotation_scans_only_selected_markets_and_skips_waiting_candidates(monkeypatch):
    rt,s,r=setup(symbols=["R_100","frxXAUUSD"]);calls=[];original=asyncio.sleep
    async def read_frames(*args):return frames()
    async def check(symbol,*args):calls.append(symbol);return {"verdict":"WAIT"}
    async def stop(delay):r.status="stopped";await original(0)
    rt.frames=read_frames;rt.analyze=check;monkeypatch.setattr(chart_auto.asyncio,"sleep",stop)
    await rt.loop(r)
    assert calls==["R_100","frxXAUUSD"] and set(r.market_status)==set(r.cfg.symbols)
    assert not any("buy" in q for q in r.channel.calls)


@pytest.mark.asyncio
async def test_closed_markets_do_not_block_other_selected_markets(monkeypatch):
    rt,s,r=setup(symbols=["R_100","frxXAUUSD"]);original=asyncio.sleep;calls=[]
    async def catalog():return [{"symbol":"R_100","supported":True,"open":False},{"symbol":"frxXAUUSD","supported":True,"open":True,"market":"commodities"}]
    async def read_frames(*args):return frames()
    async def check(symbol,*args):calls.append(symbol);return {"verdict":"WAIT"}
    async def stop(delay):r.status="stopped";await original(0)
    rt.market_loader=catalog;rt.frames=read_frames;rt.analyze=check;monkeypatch.setattr(chart_auto.asyncio,"sleep",stop)
    await rt.loop(r)
    assert calls==["frxXAUUSD"] and r.market_status["R_100"]["verdict"]=="SKIPPED"


@pytest.mark.asyncio
async def test_unsupported_multiplier_selection_is_rejected_before_buy():
    rt,s,r=setup()
    with pytest.raises(DemoError,match="no verified Options Multiplier"):await rt.start(s,configuration(symbols=["OTC_NDX"]))
    assert not any("buy" in q for q in r.channel.calls)


def test_forex_session_gaps_do_not_create_weekend_candles():
    now=time.time();raw=frames(now)[900]
    raw=raw[:10]+raw[11:]
    with pytest.raises(DemoError):closed_candles(raw,900,now)
    result=closed_candles(raw,900,now,allow_gaps=True)
    assert len(result)==len(raw) and result[10]["epoch"]-result[9]["epoch"]==1800


def test_catalog_does_not_treat_a_listed_index_as_a_multiplier():
    from lib.market_catalog import market_rows
    active=[{"underlying_symbol":"frxXAUUSD","underlying_symbol_name":"Gold","exchange_is_open":1,"is_trading_suspended":0},{"underlying_symbol":"OTC_NDX","underlying_symbol_name":"US Tech 100","exchange_is_open":1,"is_trading_suspended":0}]
    contracts={"frxXAUUSD":[{"underlying_symbol":"frxXAUUSD","contract_type":kind,"multiplier_range":[100]} for kind in ["MULTUP","MULTDOWN"]],"OTC_NDX":[{"contract_type":"CALL"}]}
    rows={r["symbol"]:r for r in market_rows(active,contracts)}
    assert rows["frxXAUUSD"]["supported"] and not rows["OTC_NDX"]["supported"]


@pytest.mark.asyncio
async def test_minute_rollover_while_loading_does_not_recheck_the_same_actual_bar(monkeypatch):
    rt,s,r=setup();clock=[time.time()];reads=[];sleeps=[];original=asyncio.sleep
    monkeypatch.setattr(chart_auto.time,"time",lambda:clock[0])
    async def read_frames(*args):clock[0]+=60;reads.append(clock[0]);return frames(clock[0])
    async def check(*args):return {"verdict":"WAIT"}
    async def stop(delay):
        sleeps.append(delay)
        if len(sleeps)==3:r.status="stopped"
        await original(0)
    rt.frames=read_frames;rt.analyze=check;monkeypatch.setattr(chart_auto.asyncio,"sleep",stop)
    await rt.loop(r)
    assert len(reads)==1
    assert r.checked_bars["R_100"]==int(clock[0])//60*60-60


@pytest.mark.asyncio
async def test_wait_diagnostics_survive_rotation_without_calling_trade_entry(monkeypatch):
    rt,s,r=setup();original=asyncio.sleep
    async def read_frames(*args):return frames()
    async def check(*args):return {"verdict":"NO_STRATEGY_MATCH","wait_summary":"WAIT — original M15/H1 source candle has not closed.","local_diagnostics":[{"timeframe":"M15","reason":"waiting_for_source_close","next_source_close":time.time()+60}]}
    async def forbidden(*args):raise AssertionError("A WAIT result must not run the trade entry pipeline")
    async def stop(delay):r.status="stopped";await original(0)
    rt.frames=read_frames;rt.analyze=check;rt.entry=forbidden;monkeypatch.setattr(chart_auto.asyncio,"sleep",stop)
    await rt.loop(r)
    row=r.public()["markets"][0]
    assert "M15/H1" in row["note"] and row["rule_checks"][0]["reason"]=="waiting_for_source_close"
    assert row["verdict"]=="WAIT" and not r.history and not r.pending
