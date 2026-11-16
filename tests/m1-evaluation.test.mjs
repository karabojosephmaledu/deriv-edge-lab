// Reproducibility/chronology checks on the fixed public dataset. Reusing these
// now-inspected observations is a regression check, not another unseen test.
import {before,test}from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';
import zlib from'node:zlib';
import crypto from'node:crypto';
import {evaluate}from'../research/m1/engine.mjs';
const root=new URL('../',import.meta.url),protocol=JSON.parse(fs.readFileSync(new URL('research/m1/protocol.json',root))),markets={};
let actual,expected;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
before(()=>{
 expected=JSON.parse(fs.readFileSync(new URL('research/m1/results.json',root)));
 for(const symbol of protocol.markets)markets[symbol]=JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('research/m1/data/'+symbol+'.json.gz',root))));
 actual=evaluate(markets,protocol);
});
test('all saved input hashes and the frozen engine/protocol/tool hashes verify',()=>{
 for(const p of expected.provenance){assert.equal(hash(fs.readFileSync(new URL('research/m1/data/'+p.symbol+'.json.gz',root))),p.sha256);assert.equal(markets[p.symbol].bars.length,p.bars);}
 for(const m of Object.values(markets))for(const [path,sha]of Object.entries(m.frozen_sha256))assert.equal(hash(fs.readFileSync(new URL(path,root))),sha,path);
});
test('public observations match declared historical dates and contain no account/order fields',()=>{
 const start=Date.parse(protocol.periods.training[0])/1000-360*60,end=Date.parse(protocol.periods.test[1])/1000;
 for(const m of Object.values(markets)){
  assert.deepEqual(m.requested,[start,end]);assert.equal(m.source,'wss://api.derivws.com/trading/v1/options/ws/public');assert.equal(m.quote.historical_executable,false);
  assert.ok(m.bars.every(b=>b.epoch>=start&&b.epoch<end));assert.ok(m.bars.length>=5000);
  assert.doesNotMatch(JSON.stringify(m),/"(?:authorize|token|account_id|buy|sell|proposal_id|longcode)"\s*:/);
 }
});
test('the stored research decision and every reported metric reproduce offline',()=>{
 const compact=structuredClone(actual);for(const row of compact.rows)for(const part of['training','validation','stress','test','testStress'])delete row[part].history;
 for(const key of Object.keys(compact))assert.deepEqual(compact[key],expected[key],key);
});
test('portfolio entries use separate next candles, fixed stakes and known period bounds',()=>{
 for(const row of actual.rows)for(const part of['training','validation','test']){
  const [start,end]=protocol.periods[part].map(x=>Date.parse(x)/1000),history=row[part].history;
  for(let i=0;i<history.length;i++){
   const t=history[i],input=markets[t.symbol].bars;
   assert.equal(t.opened_at,t.signal_at);assert.equal(t.stake,1);assert.ok(t.profit>=-1);
   assert.ok(t.opened_at>=start&&t.closed_at<=end);assert.ok(t.closed_at>t.opened_at&&t.closed_at-t.opened_at<=300);
   assert.ok(input.some(b=>b.epoch===t.signal_at-60));assert.ok(input.some(b=>b.epoch===t.opened_at));assert.ok(input.some(b=>b.epoch===t.closed_at-60));
   if(i)assert.ok(history[i-1].closed_at<=t.opened_at);
  }
 }
});
test('every stress scenario retains identical entries/exits and weakens each return',()=>{
 for(const row of actual.rows)for(const [a,b]of[['validation','stress'],['test','testStress']]){
  assert.equal(row[a].trades,row[b].trades);assert.deepEqual(row[a].rejects,row[b].rejects);
  row[a].history.forEach((t,i)=>{const s=row[b].history[i];assert.equal(t.opened_at,s.opened_at);assert.equal(t.closed_at,s.closed_at);assert.equal(t.reason,s.reason);assert.ok(s.profit<=t.profit);});
 }
});
test('returns, breaks-even and drawdown bounds agree with the actual virtual ledger',()=>{
 for(const row of actual.rows)for(const part of['training','validation','stress','test','testStress']){
  const r=row[part],h=r.history;
  assert.ok(Math.abs(h.reduce((n,t)=>n+t.profit,0)-r.net)<1e-8);assert.equal(r.trades,r.wins+r.losses+r.breakEvenTrades);
  assert.equal(r.wins,h.filter(t=>t.profit>0).length);assert.equal(r.losses,h.filter(t=>t.profit<0).length);
  assert.ok(r.maxEquityDrawdownBound>=r.maxDrawdown);
  if(r.averageWin>0&&r.averageLoss>0)assert.ok(Math.abs(r.empiricalBreakEven-r.averageLoss/(r.averageWin+r.averageLoss))<1e-12);
 }
});
test('failed training/validation retains NO TRADE and cannot authorize a broker order',()=>{
 assert.equal(actual.selectedOnValidation,null);assert.equal(actual.decision,'NO TRADE');assert.equal(actual.broker_execution_authorized,false);
 assert.ok(actual.rows.every(r=>!r.assessment.eligible&&r.assessment.reasons.length>0));
});
