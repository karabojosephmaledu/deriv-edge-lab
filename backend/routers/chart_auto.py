"""Opt-in automatic Options Multipliers, separate from the original Demo broker.

Only server-read closed candles and an audited original-strategy interpretation
can produce a quote. Actual Deriv quotes/settlements determine all money values.
Live execution is disabled unless explicitly configured on the server AND chosen
for this authorized account. No server task is started at import/startup.
"""
import asyncio
import contextlib
import json
import os
import secrets
import time
import re
from dataclasses import dataclass, field
from urllib.parse import quote, urlsplit, parse_qs

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from pymongo.errors import PyMongoError
from websockets.asyncio.client import connect

from lib.deriv_demo import Channel, DemoError, DemoRejected, SYMBOLS, amount, INSTANCE
from lib.chart_strategy import FRAMES, ENTRY_FRAME, SCAN_TIMEOUT, closed_candles, scan, price_plan, quote_limits, verify_final_quote, finite, runtime_status, AnalysisFailure
from lib.market_catalog import load_markets
from routers import deriv

router=APIRouter()


def flags():
    enabled=os.environ.get("CHART_AUTOTRADING_ENABLED","").lower()=="true"
    return {"enabled":enabled,
        "demo_enabled":enabled and os.environ.get("DERIV_DEMO_TRADING_ENABLED","").lower()=="true",
        "real_enabled":enabled and os.environ.get("DERIV_LIVE_TRADING_ENABLED","").lower()=="true",
        "ai_configured":any(os.environ.get(f"CHART_AI_SLOT_{n}_API_KEY") for n in range(1,7)),
        **runtime_status(), "product":"Options Multipliers", "analysis_engine":"local_rules","ai_required":False,
        "cadence_seconds":ENTRY_FRAME,"analysis_timeout_seconds":SCAN_TIMEOUT,"entry_timeframes":["M15","H1"]}


class AutoConfig(BaseModel):
    model_config=ConfigDict(extra="forbid",allow_inf_nan=False)
    account_id:str=Field(min_length=1,max_length=80)
    mode:str
    symbol:str="R_100"
    symbols:list[str]|None=Field(default=None,min_length=1,max_length=16)
    stake:float=Field(gt=0,le=500,strict=True)
    target:float=Field(gt=0,strict=True)
    max_loss:float=Field(gt=0,strict=True)
    acknowledge_live:bool=False

    @model_validator(mode="after")
    def valid(self):
        selected=self.symbols if self.symbols is not None else [self.symbol]
        if self.mode not in {"demo","real"} or len(set(selected))!=len(selected) or any(not re.fullmatch(r"(?:R_\d+|1HZ\d+V|frx[A-Z]{6}|cry[A-Z]{6}|OTC_[A-Z0-9]+)",s) for s in selected):
            raise ValueError("Select an authorized Demo or Real Options account and supported market")
        if self.stake<1 or any(amount(v)!=v for v in (self.stake,self.target,self.max_loss)) or self.max_loss<self.stake:
            raise ValueError("Use cents, a stake of at least $1, and a loss limit covering one full stake")
        if self.mode=="real" and not self.acknowledge_live:
            raise ValueError("Explicit Live-account selection is required")
        self.symbols=selected;self.symbol=selected[0]
        return self


def require_enabled(cfg):
    f=flags()
    if not f["enabled"] or not f[cfg.mode+"_enabled"]:
        raise DemoError("Automatic "+cfg.mode+" execution is disabled on the backend.",403)
    if not f["node_available"] or not f["worker_available"]:
        raise DemoError("Configure Node 24 and the bundled local scanner before starting.",503)


def execution_url(url, kind):
    p=urlsplit(url)
    if kind not in {"demo","real"} or p.scheme!="wss" or p.hostname!="api.derivws.com" or p.port not in (None,443) or p.username or p.password or p.fragment or p.path!="/trading/v1/options/ws/"+kind or set(parse_qs(p.query))!={"otp"} or len(parse_qs(p.query)["otp"])!=1:
        raise DemoError("The authenticated account socket does not match the selected account type.",403)
    return url


class AutoChannel(Channel):
    def __init__(self,kind,on_message,on_close):
        super().__init__(on_message,on_close); self.kind=kind

    async def open(self,url):
        self.ws=await connect(execution_url(url,self.kind),open_timeout=10,close_timeout=3,ping_interval=20,max_size=2**20)
        self.task=asyncio.create_task(self.listen())


@dataclass
class Run:
    id:str
    cfg:AutoConfig
    source:object=field(repr=False)
    channel:object=field(default=None,repr=False)
    lock:asyncio.Lock=field(default_factory=asyncio.Lock,repr=False)
    status:str="running"
    net:float=0
    history:list=field(default_factory=list)
    pending:dict|None=None
    error:str|None=None
    note:str="Waiting for original-strategy analysis."
    tick:dict|None=None
    last_bar:int=0
    analysis:dict|None=None
    task:object=field(default=None,repr=False)
    unresolved:bool=False
    heartbeat:float=0
    phase:str="starting"
    phase_at:float=field(default_factory=time.time)
    last_check_at:float|None=None
    next_check_at:float|None=None
    error_code:str|None=None
    error_details:list=field(default_factory=list)
    current_symbol:str|None=None
    ticks:dict=field(default_factory=dict)
    checked_bars:dict=field(default_factory=dict)
    frame_cache:dict=field(default_factory=dict)
    frame_boundaries:dict=field(default_factory=dict)
    market_status:dict=field(default_factory=dict)
    market_info:dict=field(default_factory=dict)
    cursor:int=0
    subscribed:set=field(default_factory=set)

    @property
    def symbol(self):return self.current_symbol or self.cfg.symbol

    def activity(self,phase,note):
        self.phase=phase;self.phase_at=time.time();self.note=note

    def public(self):
        settled=[o for o in self.history if o.get("status") in {"win","loss","break-even"}]
        wins=sum(o["profit"]>0 for o in settled); losses=sum(o["profit"]<0 for o in settled)
        return {"id":self.id,"account_id":self.cfg.account_id,"mode":self.cfg.mode,"symbol":self.symbol,"symbols":self.cfg.symbols,"markets":list(self.market_status.values()),
            "status":self.status,"stake":self.cfg.stake,"target":self.cfg.target,"max_loss":self.cfg.max_loss,
            "net":self.net,"wins":wins,"losses":losses,"settled":len(settled),
            "win_rate":wins/len(settled) if settled else None,"history":self.history[:20],"pending":self.pending,
            "note":self.note,"error":self.error,"verdict":(self.analysis or {}).get("verdict","WAIT"),
            "phase":self.phase,"phase_at":self.phase_at,"last_check_at":self.last_check_at,
            "next_check_at":self.next_check_at if self.status=="running" else None,
            "error_code":self.error_code,"error_details":self.error_details}


class Runtime:
    def __init__(self,broker=None,channel_factory=AutoChannel,analyze=scan,market_loader=load_markets):
        self._broker=broker; self.channel_factory=channel_factory; self.analyze=analyze; self.market_loader=market_loader;self.runs={};self.start_lock=asyncio.Lock()

    @property
    def broker(self):return self._broker or deriv.broker()

    @property
    def db(self):return self.broker.db

    async def account(self,s,cfg):
        account=next((a for a in await self.broker.list_accounts(s) if a.get("account_id")==cfg.account_id),None)
        if not account or account.get("status")!="active" or account.get("account_type")!=cfg.mode or account.get("currency")!="USD":
            raise DemoError("Deriv did not authorize this active USD account and account type.",403)
        return account

    def fresh(self,r):
        require_enabled(r.cfg)
        if self.broker.sessions.get(r.source.sid) is not r.source or r.source.expires<=time.time():
            raise DemoError("The authorized account session ended. Reconnect before new entries.",401)

    async def channel(self,r):
        await self.account(r.source,r.cfg)
        response=await self.broker.rest(r.source,"POST","/trading/v1/options/accounts/"+quote(r.cfg.account_id,safe="")+"/otp")
        r.channel=self.channel_factory(r.cfg.mode,lambda m:self.message(r,m),lambda:self.disconnected(r))
        await r.channel.open((response.get("data") or {}).get("url",""))
        await self.balance(r)

    async def balance(self,r):
        data=(await r.channel.request({"balance":1})).get("balance") or {}
        if data.get("currency")!="USD" or data.get("loginid",r.cfg.account_id)!=r.cfg.account_id or finite(data.get("balance"))<0:
            raise DemoError("The authenticated account balance could not be verified.",502)
        return finite(data["balance"])

    async def portfolio(self,r):
        contracts=((await r.channel.request({"portfolio":1})).get("portfolio") or {}).get("contracts")
        if not isinstance(contracts,list):raise DemoError("The account's open contracts could not be verified.",502)
        return contracts

    def message(self,r,m):
        t=m.get("tick")
        if t and t.get("symbol") in r.cfg.symbols:
            try:
                if type(t.get("epoch")) is not int or type(t.get("pip_size")) is not int or finite(t.get("quote"))<=0:return
                previous=r.ticks.get(t["symbol"])
                if previous and t["epoch"]<=previous["epoch"]:return
                r.ticks[t["symbol"]]={"epoch":t["epoch"],"quote":finite(t["quote"]),"pip":t["pip_size"],"received":time.monotonic()}
                if t["symbol"]==r.symbol:r.tick=r.ticks[t["symbol"]]
            except DemoError:pass

    def disconnected(self,r):
        r.status="stopped";r.error="Account connection interrupted. New entries stopped; provider exits remain attached to any acknowledged contract."

    async def save(self,r):
        await self.db.chart_runs.update_one({"_id":r.id,"instance":INSTANCE},{"$set":{"status":r.status,"net":r.net,"last_bar":r.last_bar,"note":r.note,
            "phase":r.phase,"phase_at":r.phase_at,"last_check_at":r.last_check_at,"next_check_at":r.next_check_at,
            "error":r.error,"error_code":r.error_code,"error_details":r.error_details,"updated_at":time.time()}})
        r.heartbeat=time.monotonic()

    async def start(self,s,cfg):
        require_enabled(cfg)
        async with self.start_lock:
            previous=self.runs.get(s.sid)
            if previous and (previous.task and not previous.task.done() or previous.pending or previous.unresolved):
                raise DemoError("Stop the existing session and let its contract settle before starting another.",409)
            if s.pending or s.status in {"running","paused"}:raise DemoError("The original Demo bot already has a session or contract.",409)
            r=Run(secrets.token_hex(16),cfg,s); self.fresh(r)
            await self.account(s,cfg)
            catalog={m["symbol"]:m for m in await self.market_loader()}
            if any(code not in catalog or not catalog[code]["supported"] for code in cfg.symbols):
                raise DemoError("A selected market has no verified Options Multiplier contracts. Choose only enabled markets.",409)
            r.market_info=catalog
            try:
                await self.db.demo_account_locks.find_one_and_update({"_id":cfg.account_id,"state":"idle"},
                    {"$set":{"state":"chart-scanning","order_id":r.id,"instance":INSTANCE}},upsert=True,return_document=ReturnDocument.AFTER)
            except DuplicateKeyError:
                raise DemoError("This account has an active or unresolved session. Reconcile it before any new order.",409) from None
            try:
                await self.channel(r)
                if await self.portfolio(r):raise DemoError("Let the account's existing contracts finish before automatic trading.",409)
                if await self.balance(r)<cfg.stake:raise DemoError("The authorized account has insufficient available balance.",409)
                await self.db.chart_runs.insert_one({"_id":r.id,"account_id":cfg.account_id,"config":cfg.model_dump(),"status":"running","net":0,"last_bar":0,"instance":INSTANCE,"created_at":time.time()})
                for code in cfg.symbols:
                    if catalog[code].get("open"):
                        await r.channel.request({"ticks":code,"subscribe":1});r.subscribed.add(code)
            except BaseException:
                if r.channel:await r.channel.close()
                await self.db.demo_account_locks.update_one({"_id":cfg.account_id,"order_id":r.id,"instance":INSTANCE},{"$set":{"state":"idle"}})
                raise
            self.runs[s.sid]=r
            r.task=asyncio.create_task(self.loop(r))
            return r.public()

    def at_limit(self,r):
        if r.net>=r.cfg.target or r.net<=-r.cfg.max_loss or len(r.history)>=1000:
            r.status="stopped";r.note="Session limit reached; start a new session to continue."
            return True
        return False

    async def control(self,s,run_id,action):
        r=self.runs.get(s.sid)
        if not r or r.id!=run_id:raise DemoError("This session is no longer current.",409)
        # Publish pause/stop before awaiting the entry mutex: an in-flight quote
        # must see the instruction at its final pre-buy check. An already-sent
        # buy cannot be cancelled by pretending it did not happen.
        if action=="stop":r.status="stopped";r.note="Stopped new entries. Any current contract keeps its provider stop and target."
        elif action=="pause" and r.status=="running":r.status="paused";r.note="Paused new entries; current contract remains monitored."
        elif action=="resume" and r.status=="paused":
            async with r.lock:
                self.fresh(r)
                if r.status=="paused" and not self.at_limit(r):r.status="running";r.note="Waiting for the next valid source setup."
        else:raise DemoError("This control is unavailable for the current session state.",409)
        await self.save(r)
        return r.public()

    async def frames(self,r):
        frames={}
        for g in FRAMES:
            cached=r.frame_cache.get((r.symbol,g))
            boundary=int(time.time())//g*g-g
            if cached and r.frame_boundaries.get((r.symbol,g))==boundary:
                frames[g]=cached;continue
            r.note="Loading "+FRAMES[g]+" closed Deriv candles."
            try:response=await r.channel.request({"ticks_history":r.symbol,"end":"latest","style":"candles","granularity":g,"count":161})
            except DemoError as exc:raise DemoError("Could not load "+FRAMES[g]+" market history. "+str(exc),exc.status) from None
            gaps=r.market_info.get(r.symbol,{}).get("market") in {"forex","commodities","indices"}
            try:frames[g]=closed_candles(response.get("candles"),g,time.time(),allow_gaps=gaps)
            except DemoError as exc:raise DemoError(FRAMES[g]+" closed history: "+str(exc),exc.status) from None
            r.frame_cache[r.symbol,g]=frames[g]
            r.frame_boundaries[r.symbol,g]=boundary
        return frames

    async def entry(self,r,frames,result):
        async with r.lock:
            self.fresh(r)
            if r.status!="running" or r.pending or r.unresolved or self.at_limit(r):return
            # Budget the full stake, including the risk of a gap/stop-out.
            if amount(r.net-r.cfg.stake)<-r.cfg.max_loss:
                r.status="stopped";r.note="The remaining loss allowance cannot cover another full stake.";return
            if not r.tick or time.monotonic()-r.tick["received"]>5 or not 0<=time.time()-r.tick["epoch"]<=10:
                raise DemoError("WAIT — the provider price feed is stale.",409)
            if frames[ENTRY_FRAME][-1]["epoch"]!=int(time.time())//ENTRY_FRAME*ENTRY_FRAME-ENTRY_FRAME:
                raise DemoError("WAIT — a new entry candle closed during analysis; refresh the setup.",409)
            plan=price_plan(result,r.symbol,frames,r.tick["pip"])
            await self.account(r.source,r.cfg)
            if await self.balance(r)<r.cfg.stake or await self.portfolio(r):raise DemoError("WAIT — balance or existing contracts block a new entry.",409)
            kind="MULTUP" if plan["direction"]=="BUY" else "MULTDOWN"
            available=((await r.channel.request({"contracts_for":r.symbol})).get("contracts_for") or {}).get("available",[])
            contract=next((c for c in available if c.get("contract_type")==kind and c.get("underlying_symbol")==r.symbol),{})
            multiples=contract.get("multiplier_range")
            if not isinstance(multiples,list) or not multiples or any(type(v) is not int or v<=0 for v in multiples):
                raise DemoError("Deriv has not confirmed an available Multiplier for this symbol.",409)
            multiplier=min(multiples) # Lowest provider-listed leverage; no stake progression.
            query={"proposal":1,"amount":r.cfg.stake,"basis":"stake","currency":"USD","underlying_symbol":r.symbol,"contract_type":kind,"multiplier":multiplier}
            r.activity("quoting","Checking the authenticated Deriv entry quote and protective exits.")
            first=(await r.channel.request(query)).get("proposal") or {}
            limits=quote_limits(first,plan,r.cfg.stake,multiplier)
            final=(await r.channel.request({**query,"limit_order":limits})).get("proposal") or {}
            verify_final_quote(final,plan,r.cfg.stake,multiplier,limits,time.time())
            self.fresh(r)
            if r.status!="running" or self.at_limit(r):return
            if frames[ENTRY_FRAME][-1]["epoch"]!=int(time.time())//ENTRY_FRAME*ENTRY_FRAME-ENTRY_FRAME:
                r.activity("waiting","WAIT — the next M1 candle closed before quoting finished. No order sent.")
                return
            order_id=r.id+":"+r.symbol+":"+str(frames[ENTRY_FRAME][-1]["epoch"])
            order={"_id":order_id,"id":order_id,"run_id":r.id,"account_id":r.cfg.account_id,"status":"ordering",
                "contract_id":None,"stake":r.cfg.stake,"symbol":r.symbol,"direction":plan["direction"],"multiplier":multiplier,
                "limits":limits,"price_plan":plan,"analysis":result,"opened_at":time.time(),"profit":None}
            await self.db.chart_orders.insert_one(order)
            owned=await self.db.demo_account_locks.find_one_and_update({"_id":r.cfg.account_id,"order_id":r.id,"instance":INSTANCE,"state":"chart-scanning"},
                {"$set":{"state":"chart-ordering"}},return_document=ReturnDocument.AFTER)
            if not owned:
                await self.db.chart_orders.update_one({"_id":order_id},{"$set":{"status":"not_sent"}})
                r.status="stopped"
                raise DemoError("Account ownership changed during analysis. No buy was sent.",409)
            r.unresolved=True;r.pending={k:order[k] for k in ("id","status","contract_id","symbol","stake","direction","multiplier")}
            try:
                self.fresh(r)
                send=r.status=="running" and not self.at_limit(r) and frames[ENTRY_FRAME][-1]["epoch"]==int(time.time())//ENTRY_FRAME*ENTRY_FRAME-ENTRY_FRAME
            except DemoError:
                send=False
            if not send:
                await self.db.chart_orders.update_one({"_id":order_id},{"$set":{"status":"not_sent"}})
                await self.db.demo_account_locks.update_one({"_id":r.cfg.account_id,"order_id":r.id,"instance":INSTANCE},{"$set":{"state":"chart-scanning"}})
                r.unresolved=False;r.pending=None
                return
            try:
                r.activity("ordering","Order acknowledgement pending. No duplicate buy will be sent.")
                receipt=(await r.channel.request({"buy":str(final["id"]),"price":r.cfg.stake})).get("buy") or {}
                if type(receipt.get("contract_id")) is not int or amount(receipt.get("buy_price"))!=r.cfg.stake:
                    raise DemoError("The provider did not acknowledge a matching contract.",502)
                order.update(contract_id=receipt["contract_id"],buy_price=amount(receipt["buy_price"]),status="open")
                await self.db.chart_orders.update_one({"_id":order_id},{"$set":{k:order[k] for k in ("contract_id","buy_price","status")}})
                r.pending.update(status="open",contract_id=order["contract_id"])
                r.activity("contract_open","Deriv acknowledged the contract; monitoring its actual settlement.")
            except DemoRejected:
                await self.db.chart_orders.update_one({"_id":order_id},{"$set":{"status":"rejected"}})
                r.unresolved=False;r.pending=None;r.status="stopped"
                raise DemoError("Deriv rejected the buy. No automatic retry will be sent.",409) from None
            except BaseException:
                r.status="stopped";r.error="Buy outcome unresolved. No retry is sent. Reconnect and reconcile the provider statement before starting again."
                raise
        await self.monitor(r,order)

    async def monitor(self,r,order):
        while True:
            # A long-lived contract is still owned while entries are paused or
            # stopped. Do not let another process mistake it for a dead worker.
            if time.monotonic()-r.heartbeat>=10:await self.save(r)
            info=((await r.channel.request({"proposal_open_contract":1,"contract_id":order["contract_id"]})).get("proposal_open_contract") or {})
            if info.get("contract_id")!=order["contract_id"]:raise DemoError("The provider returned a different contract.",502)
            if info.get("is_sold")==1:
                profit,bought,sold=amount(info.get("profit")),amount(info.get("buy_price")),amount(info.get("sell_price"))
                if bought!=r.cfg.stake or amount(sold-bought)!=profit or profit < -bought:
                    raise DemoError("Provider settlement amounts could not be verified.",502)
                record={"id":order["id"],"contract_id":order["contract_id"],"symbol":order.get("symbol",r.symbol),"stake":bought,"return":sold,"profit":profit,
                    "status":"win" if profit>0 else "loss" if profit<0 else "break-even","closed_at":finite(info.get("sell_time") or time.time())}
                await self.db.chart_orders.update_one({"_id":order["_id"]},{"$set":record})
                if not any(o["id"]==record["id"] for o in r.history):r.history.insert(0,record);r.net=amount(r.net+profit)
                r.pending=None;r.unresolved=False
                r.activity("waiting","Deriv settled the contract. Waiting for the next closed one-minute candle.")
                self.at_limit(r);await self.save(r)
                await self.db.demo_account_locks.update_one({"_id":r.cfg.account_id,"order_id":r.id,"instance":INSTANCE},{"$set":{"state":"chart-scanning"}})
                return
            if r.pending and info.get("profit") is not None:r.pending["profit"]=amount(info["profit"])
            await asyncio.sleep(2)

    async def loop(self,r):
        try:
            while r.status in {"running","paused"} or r.pending:
                self.fresh(r)
                if time.monotonic()-r.heartbeat>=10:await self.save(r)
                if r.status=="running":
                    bar=int(time.time())//ENTRY_FRAME*ENTRY_FRAME-ENTRY_FRAME
                    if any(r.checked_bars.get(code)!=bar for code in r.cfg.symbols):
                        r.market_info={m["symbol"]:m for m in await self.market_loader()}
                        first=r.cursor;before=len(r.history)
                        for offset in range(len(r.cfg.symbols)):
                            if r.status!="running" or r.pending or r.unresolved:break
                            symbol=r.cfg.symbols[(first+offset)%len(r.cfg.symbols)]
                            if r.checked_bars.get(symbol)==bar:continue
                            r.checked_bars[symbol]=bar;info=r.market_info.get(symbol,{})
                            if not info.get("supported") or not info.get("open"):
                                r.market_status[symbol]={"symbol":symbol,"name":info.get("name",symbol),"verdict":"SKIPPED","note":"Market closed or no verified Multiplier available.","checked_at":time.time()};continue
                            r.current_symbol=symbol;r.tick=r.ticks.get(symbol,r.tick if len(r.cfg.symbols)==1 else None)
                            r.activity("loading_candles","Scanning "+info.get("name",symbol)+" — loading closed candles.");await self.save(r)
                            try:
                                if symbol not in r.subscribed:
                                    await r.channel.request({"ticks":symbol,"subscribe":1});r.subscribed.add(symbol)
                                frames=await asyncio.wait_for(self.frames(r),12)
                            except (DemoError,TimeoutError) as exc:
                                if isinstance(exc,DemoError) and exc.status in {401,403} or r.status!="running":raise
                                reason=str(exc) if isinstance(exc,DemoError) else "History request timed out."
                                r.market_status[symbol]={"symbol":symbol,"name":info.get("name",symbol),"verdict":"WAIT","note":"Closed market history unavailable; no entry. "+reason,"checked_at":time.time()};continue
                            r.last_bar=frames[ENTRY_FRAME][-1]["epoch"]
                            r.checked_bars[symbol]=r.last_bar
                            r.activity("analysing","Checking local rules on "+info.get("name",symbol)+". No AI credits used.");await self.save(r)
                            result=await self.analyze(symbol,frames,None)
                            r.analysis=result;r.last_check_at=time.time();r.next_check_at=int(time.time())//ENTRY_FRAME*ENTRY_FRAME+ENTRY_FRAME
                            r.activity("waiting",result.get("wait_summary") or "WAIT — no complete locally verified setup on "+info.get("name",symbol)+".")
                            settled_before=len(r.history)
                            try:
                                if result.get("verdict") in {"BUY_NOW","SELL_NOW"}:await self.entry(r,frames,result)
                            except DemoError as exc:
                                if exc.status!=409:raise
                                r.note=str(exc)
                            r.market_status[symbol]={"symbol":symbol,"name":info.get("name",symbol),"verdict":"TRADED" if len(r.history)>settled_before else "WAIT","analysis_verdict":result.get("verdict","WAIT"),"note":r.note,"rule_checks":result.get("local_diagnostics",[]),"checked_at":time.time()}
                            await self.save(r)
                            if int(time.time())//ENTRY_FRAME*ENTRY_FRAME-ENTRY_FRAME!=bar:break
                        r.cursor=(first+1)%len(r.cfg.symbols)
                        if r.status=="running" and len(r.history)==before:r.activity("waiting","WAIT — no eligible M15/H1 entry. Latest market checks show why.")
                        r.next_check_at=int(time.time())//ENTRY_FRAME*ENTRY_FRAME+ENTRY_FRAME
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            r.status="stopped";r.note="Server stopped; no automatic restart. Reconcile any acknowledged contract."
            raise
        except DemoError as exc:
            failed_phase=r.phase;r.status="stopped";r.phase="error";r.phase_at=time.time()
            if not r.error:r.error=str(exc)
            r.error_code=getattr(exc,"code",{"loading_candles":"market_history_failed","quoting":"quote_failed","analysing":"analysis_failed"}.get(failed_phase,"account_connection_failed"))
            if isinstance(exc,AnalysisFailure):r.error_details=exc.details
        except PyMongoError:
            r.status="stopped";r.activity("error","The session database could not be reached.")
            r.error_code="database_unavailable";r.error="The session database is unavailable. New entries stopped; reconcile any acknowledged contract before restarting."
        except Exception:
            failed_phase=r.phase;r.status="stopped";r.phase="error";r.phase_at=time.time();r.error_code="server_error"
            if not r.error:r.error="Unexpected server failure during "+failed_phase.replace("_"," ")+". New entries stopped; refresh account status before retrying."
        finally:
            if not r.unresolved and not r.pending:
                with contextlib.suppress(Exception):
                    await self.db.demo_account_locks.update_one({"_id":r.cfg.account_id,"order_id":r.id,"instance":INSTANCE},{"$set":{"state":"idle"}})
            with contextlib.suppress(Exception):await self.save(r)
            if r.channel:await r.channel.close()

    async def shutdown(self):
        for r in self.runs.values():
            if r.task and not r.task.done():r.task.cancel()
        await asyncio.gather(*(r.task for r in self.runs.values() if r.task),return_exceptions=True)

    async def recover(self,s,account_id):
        """Reattach settlement monitoring only. Never repeat a buy or restart entries."""
        async with self.start_lock:
            current=self.runs.get(s.sid)
            if current and current.task and not current.task.done():return current.public()
            lock=await self.db.demo_account_locks.find_one({"_id":account_id})
            if not lock or lock.get("state")=="idle":raise DemoError("No unresolved automatic session was found.",409)
            stored=await self.db.chart_runs.find_one({"_id":lock.get("order_id"),"account_id":account_id})
            if not stored:raise DemoError("The unresolved session belongs to the original Demo broker; use its recovery controls.",409)
            cfg=AutoConfig(**stored["config"]);await self.account(s,cfg)
            if lock.get("instance")!=INSTANCE and time.time()-stored.get("updated_at",stored.get("created_at",time.time()))<300:
                raise DemoError("The previous server may still be active. Wait for its five-minute recovery lease; no new order was made.",409)
            # A Mongo compare-and-set permits only one recovery monitor process.
            if lock.get("instance")==INSTANCE and any(r.id==stored["_id"] and r.task and not r.task.done() for r in self.runs.values()):
                raise DemoError("This account is still monitored by its existing session.",409)
            owned=await self.db.demo_account_locks.find_one_and_update({"_id":account_id,"order_id":stored["_id"],"instance":lock.get("instance")},
                {"$set":{"instance":INSTANCE}},return_document=ReturnDocument.AFTER)
            if not owned:raise DemoError("Another process is reconciling this session.",409)
            await self.db.chart_runs.update_one({"_id":stored["_id"]},{"$set":{"instance":INSTANCE,"status":"stopped"}})
            orders=await self.db.chart_orders.find({"run_id":stored["_id"]}).sort("opened_at",-1).to_list(length=1000)
            unfinished=[o for o in orders if o["status"] in {"ordering","open"}]
            if len(unfinished)>1 or any(not o.get("contract_id") for o in unfinished) or lock.get("state")=="chart-ordering" and not unfinished:
                raise DemoError("An earlier buy has an unknown outcome. Verify it in the Deriv statement; no retry or lock release is allowed.",409)
            r=Run(stored["_id"],cfg,s,status="stopped",note="Recovered monitoring only; automatic entries remain stopped.")
            if unfinished:r.current_symbol=unfinished[0].get("symbol") or cfg.symbol
            r.history=[{k:o.get(k) for k in ("id","contract_id","symbol","stake","return","profit","status","closed_at")} for o in orders if o["status"] in {"win","loss","break-even"}]
            r.net=amount(sum(o["profit"] for o in r.history));r.last_bar=stored.get("last_bar",0)
            await self.channel(r);self.runs[s.sid]=r
            async def watch():
                try:
                    if unfinished:
                        order=unfinished[0];r.pending={k:order.get(k) for k in ("id","contract_id","stake","direction","multiplier","status")};r.unresolved=True
                        await self.monitor(r,order)
                    # With no order intent, an interrupted analysis has no buy to retry.
                    await self.db.demo_account_locks.update_one({"_id":account_id,"order_id":r.id,"instance":INSTANCE},{"$set":{"state":"idle"}})
                except Exception:r.error="Settlement monitoring unavailable. The account lock remains; retry recovery after reconnecting."
                finally:
                    await self.save(r)
                    if r.channel:await r.channel.close()
            r.task=asyncio.create_task(watch())
            return r.public()


runtime=Runtime()


@router.get("/deriv/chart/config")
async def config():return flags()


@router.get("/deriv/chart/markets")
async def markets():return {"markets":await deriv.checked(load_markets()),"checked_at":time.time()}


@router.get("/deriv/chart/status")
async def status(request:Request):
    s=deriv.session(request);r=runtime.runs.get(s.sid)
    return {"run":r.public() if r else None}


@router.post("/deriv/chart/start")
async def start(body:AutoConfig,request:Request):
    return await deriv.checked(runtime.start(deriv.session(request,True),body))


class Control(BaseModel):
    model_config=ConfigDict(extra="forbid")
    run_id:str=Field(min_length=1,max_length=80)
    action:str


@router.post("/deriv/chart/control")
async def control(body:Control,request:Request):
    return await deriv.checked(runtime.control(deriv.session(request,True),body.run_id,body.action))


class Recover(BaseModel):
    model_config=ConfigDict(extra="forbid")
    account_id:str=Field(min_length=1,max_length=80)


@router.post("/deriv/chart/recover")
async def recover(body:Recover,request:Request):
    return await deriv.checked(runtime.recover(deriv.session(request,True),body.account_id))
