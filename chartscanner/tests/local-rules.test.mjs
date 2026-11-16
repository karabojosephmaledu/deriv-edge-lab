import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localScan} from '../../backend/chartscanner/src/lib/local-rules.server.ts';

function fixture() {
 const end=1794823200,data={};
 for(const g of [86400,14400,3600,900,300,60]) {
  const boundary=Math.floor(end/g)*g;
  data[g]=Array.from({length:160},(_,i)=>({epoch:boundary-g*(160-i),open:100,high:105,low:99,close:101}));
 }
 const old=data[900].slice(-4);
 const values=[{open:99.08,high:99.25,low:98.99,close:99.1},{open:99.1,high:99.2,low:99.05,close:99.15},{open:99.15,high:99.3,low:99.10,close:99.24},{open:99.24,high:99.4,low:99.2,close:99.35}];
 data[900].splice(-4,4,...old.map((b,i)=>({...b,...values[i]})));return data;
}

test('local documented reversal is source-linked and uses no fetch or AI credentials',()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Network forbidden in local checks');};
 try {
  const result=localScan('R_100',fixture());
  assert.equal(result.verdict,'BUY_NOW');assert.equal(result.analysis_method,'local_ohlc_rules');
  assert.equal(result.policy_audit.agreeing_entry_strategies,2);assert.equal(result.policy_audit.confirmations,4);
  assert.equal(result.strategy_evaluations.length,17);assert.equal(result.broker_execution_authorized,false);
  assert.deepEqual(result.multiplier_plan.source_strategy_ids,['candle-range-theory','giant-killer']);
  assert.equal(result.strategy_evaluations.filter(s=>s.status==='unverifiable').length,15);
 } finally{globalThis.fetch=original;}
});
test('the documented mirrored reversal can produce a SELL interpretation',()=>{
 const data=fixture();for(const bars of Object.values(data))for(const b of bars){const h=b.high,l=b.low;b.open=200-b.open;b.close=200-b.close;b.high=200-l;b.low=200-h;}
 const result=localScan('frxXAUUSD',data);assert.equal(result.verdict,'SELL_NOW');assert.equal(result.multiplier_plan.direction,'SELL');
});
test('a missing raid close-back or missing opposite confirmation never forces an entry',()=>{
 for(const change of ['no_raid','no_close_back','no_confirmation','no_support']) {
  const data=fixture();if(change==='no_raid')data[900].at(-4).low=99.01;
  if(change==='no_close_back')data[900].at(-4).close=98.995;
  if(change==='no_confirmation')data[900].at(-1).close=99.2;
  if(change==='no_support')data[900].at(-5).low=99.01;
  const result=localScan('R_100',data);assert.ok(!['BUY_NOW','SELL_NOW'].includes(result.verdict));
 }
});
test('Giant Killer is not silently invented on M1 or chased after its source candle',()=>{
 const data=fixture();data[60].at(-1).epoch+=60;
 assert.ok(!['BUY_NOW','SELL_NOW'].includes(localScan('R_100',data).verdict));
});
test('invalid candle values and missing timeframes cannot produce a setup',()=>{
 for(const change of ['missing','invalid']) {
  const data=fixture();if(change==='missing')delete data[300];else data[60][0].close=NaN;
  assert.equal(localScan('R_100',data).verdict,'INVALID_SETUP');
 }
});
