"""Read-only provider discovery. An asset name is never proof of a contract."""
import asyncio
import json
import time
from websockets.asyncio.client import connect
from lib.deriv_demo import DemoError, SYMBOLS

REQUESTED={"frxXAUUSD","frxEURUSD","frxGBPUSD","frxUSDJPY","cryBTCUSD","OTC_NDX","OTC_DJI","OTC_FTSE","OTC_HSI"}
ALIASES={"OTC_NDX":"NAS100","OTC_DJI":"US30","OTC_FTSE":"UK100","OTC_HSI":"HK50"}
_cache=None
_expires=0
_lock=asyncio.Lock()


def market_rows(active, contracts):
    result=[]
    for item in active:
        symbol=item.get("underlying_symbol") or item.get("symbol")
        if symbol not in SYMBOLS | REQUESTED:continue
        available=contracts.get(symbol,[])
        kinds={c.get("contract_type") for c in available if c.get("underlying_symbol")==symbol and c.get("multiplier_range")}
        name=str(item.get("underlying_symbol_name") or item.get("display_name") or symbol)[:100]
        result.append({"symbol":symbol,"name":(ALIASES[symbol]+" / "+name) if symbol in ALIASES else name,
            "market":str(item.get("market") or ""),"supported":{"MULTUP","MULTDOWN"}<=kinds,
            "open":item.get("exchange_is_open")==1 and item.get("is_trading_suspended")==0,
            "reason":None if {"MULTUP","MULTDOWN"}<=kinds else "No Options Multiplier contracts returned by Deriv"})
    return sorted(result,key=lambda r:(not r["supported"],r["market"],r["name"]))


async def load_markets():
    global _cache,_expires
    async with _lock:
        if _cache is not None and time.monotonic()<_expires:return _cache
        try:
            async with connect("wss://api.derivws.com/trading/v1/options/ws/public",open_timeout=10,close_timeout=2,max_size=2**22) as ws:
                await ws.send(json.dumps({"active_symbols":"brief","req_id":1}))
                response=json.loads(await asyncio.wait_for(ws.recv(),10))
                active=response.get("active_symbols")
                if not isinstance(active,list):raise ValueError
                candidates=[r for r in active if (r.get("underlying_symbol") or r.get("symbol")) in SYMBOLS | REQUESTED]
                contracts={}
                # Small bounded batches; no authorization or order methods.
                for offset in range(0,len(candidates),4):
                    batch=candidates[offset:offset+4];pending={}
                    for i,row in enumerate(batch,offset+2):
                        symbol=row.get("underlying_symbol") or row["symbol"];pending[i]=symbol
                        await ws.send(json.dumps({"contracts_for":symbol,"req_id":i}))
                    while pending:
                        reply=json.loads(await asyncio.wait_for(ws.recv(),10));symbol=pending.pop(reply.get("req_id"),None)
                        if symbol:contracts[symbol]=(reply.get("contracts_for") or {}).get("available",[])
                _cache=market_rows(active,contracts);_expires=time.monotonic()+60
                return _cache
        except Exception:
            raise DemoError("Could not verify the available Deriv markets. Retry market discovery; no order was sent.",503) from None
