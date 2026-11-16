import {test}from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';
import {execFileSync}from'node:child_process';
import {PARAMETERS,IDS,checkedBars,prepare,signal,quoteScenario,settle,summarize,replay,assess,dayLowerBound,evaluate}from'../research/m1/engine.mjs';
const protocol=JSON.parse(fs.readFileSync(new URL('../research/m1/protocol.json',import.meta.url)));
const epoch=Date.parse('2026-10-19T00:00:00Z')/1000;
const bars=(n=1000)=>Array.from({length:n},(_,i)=>({epoch:epoch+i*60,open:100+i*.01,high:100.04+i*.01,low:99.96+i*.01,close:100.02+i*.01}));
const trending=(n=1000)=>Array.from({length:n},(_,i)=>({epoch:epoch+i*60,open:100+i*.2,close:100.1+i*.2,high:100.11+i*.2,low:99.99+i*.2}));
function quote(){const q={ask_price:1,multiplier:40,commission:.02,validation_params:{stop_loss:{min:.1,max:1},take_profit:{min:.1,max:50}}};return{pip:2,BUY:structuredClone(q),SELL:structuredClone(q)};}
function context(){const a=bars(400).map(b=>({...b,open:99.5,close:99.5,low:99,high:100}));a[398]={...a[398],open:100,close:99,high:100,low:98};a[399]={...a[399],open:99,close:101,high:102,low:99};return{bars:a,fast:a.map(()=>100),slow:a.map(()=>99),bias:a.map(()=>'BUY'),atr:a.map(()=>1)};}
function position(side='BUY'){return{sig:{id:'m1-pullback',symbol:'R_100',side,signal_at:epoch},sign:side==='BUY'?1:-1,entry:100,stop:side==='BUY'?99:101,target:side==='BUY'?101.5:98.5,commission:.02,multiplier:40,increment:.01,opened_at:epoch,plannedLoss:.42,plannedGain:.58,bars:0};}

test('the two presets are explicit research rules and match the frozen protocol',()=>{
 assert.deepEqual(IDS,protocol.candidates);assert.equal(PARAMETERS.fast,protocol.parameters.fast_ema);assert.equal(PARAMETERS.slow,protocol.parameters.slow_ema);
 assert.equal(PARAMETERS.reward,protocol.parameters.reward_to_price_risk);assert.equal(PARAMETERS.maxMinutes,protocol.parameters.maximum_holding_minutes);assert.equal(PARAMETERS.stake,1);
});
test('malformed, repeated, negative and unfinished-minute-aligned input is rejected',()=>{
 for(const edit of[b=>b[1].epoch=b[0].epoch,b=>b[0].close=NaN,b=>b[0].open=true,b=>b[0].low=-1,b=>b[0].epoch++]){const a=bars();edit(a);assert.throws(()=>checkedBars(a));}
});
test('M5 trend uses only full, already-closed five-minute groups',()=>{
 const a=bars(600),left=prepare(a),b=structuredClone(a);for(let i=401;i<b.length;i++)Object.assign(b[i],{open:20,high:21,low:19,close:20});
 const right=prepare(b);assert.deepEqual(left.bias.slice(0,401),right.bias.slice(0,401));assert.deepEqual(left.fast.slice(0,401),right.fast.slice(0,401));
 assert.equal(left.bias[248],null);assert.equal(left.bias[249],'BUY');
});
test('the pullback and breakout produce source-independent closed-bar BUY signals',()=>{
 const p=context();for(const id of IDS){const s=signal(p,399,id);assert.equal(s.side,'BUY');assert.equal(s.signal_at,p.bars[399].epoch+60);assert.equal(s.broker_execution_authorized,false);assert.equal(s.experimental,true);}
});
test('both entry definitions have mirrored SELL behavior',()=>{
 const p=context();for(const b of p.bars){const low=b.low,high=b.high;b.open=200-b.open;b.close=200-b.close;b.low=200-high;b.high=200-low;}p.slow=p.slow.map(()=>101);p.bias=p.bias.map(()=>'SELL');
 for(const id of IDS)assert.equal(signal(p,399,id).side,'SELL');
});
test('missing higher-timeframe agreement and recent history gaps return no signal',()=>{
 const p=context();p.bias[399]='SELL';assert.equal(signal(p,399,IDS[0]),null);p.bias[399]='BUY';p.bars[399].epoch+=60;assert.equal(signal(p,399,IDS[0]),null);
});
test('quote scenarios reject missing commission, invalid precision, wrong stake and missing limits',()=>{
 for(const edit of[q=>q.BUY.commission=NaN,q=>q.BUY.commission=-.1,q=>q.BUY.ask_price=2,q=>q.pip=true,q=>delete q.BUY.validation_params.stop_loss]){const q=quote();edit(q);assert.equal(quoteScenario(q,'BUY'),null);}
});
test('simultaneous target and stop touches settle adversely and flag ambiguity',()=>{
 const result=settle(position(),{epoch,open:100,high:102,low:98,close:101});assert.equal(result.reason,'stop');assert.equal(result.ambiguous,true);assert.ok(result.profit<0);
});
test('stop gaps fill adversely while favourable target gaps do not fabricate extra profit',()=>{
 const gap=settle(position(),{epoch,open:98,high:99,low:97,close:98}),favourable=settle(position(),{epoch,open:103,high:104,low:102,close:103});
 assert.equal(gap.reason,'gap_stop');assert.equal(gap.exit,97.99);assert.equal(favourable.reason,'target');assert.equal(favourable.exit,101.49);
});
test('provider full-stake stop-out caps losses for both directions',()=>{
 for(const side of['BUY','SELL']){const p=position(side);const r=settle(p,{epoch,open:side==='BUY'?1:1000,high:1001,low:.5,close:100});assert.equal(r.profit,-1);}
});
test('five-minute time exit realizes a loss or gain rather than pretending it hit target',()=>{
 const p=position();p.bars=4;const r=settle(p,{epoch,open:100,high:100.1,low:99.9,close:99.95});assert.equal(r.reason,'time');assert.ok(r.profit<0);
});
test('cost stress uses identical paths and can never improve a settlement',()=>{
 for(const side of['BUY','SELL'])for(const b of[{epoch,open:100,high:102,low:98,close:101},{epoch,open:100,high:102,low:99.5,close:101},{epoch,open:103,high:104,low:102,close:103}]){
  const a=settle(position(side),b),s=settle(position(side),b,true);assert.equal(s?.reason,a?.reason);assert.ok(!a||s.profit<=a.profit);
 }
});
test('accounting distinguishes break-even, observed reward/risk and empirical break-even wins',()=>{
 const r=summarize([{profit:.3},{profit:-.6},{profit:0},{profit:.3}]);assert.equal(r.net,0);assert.equal(r.wins,2);assert.equal(r.losses,1);assert.equal(r.breakEvenTrades,1);assert.equal(r.riskReward,.5);assert.ok(Math.abs(r.empiricalBreakEven-2/3)<1e-10);assert.equal(r.maxDrawdown,.6);
 assert.equal(summarize([{profit:1}]).empiricalBreakEven,null);
});
test('empty replay is NO evidence, not a zero-risk profitable result',()=>{
 const r=replay({R_100:{bars:bars(),quote:quote()}},IDS[0],epoch,epoch+1000*60);assert.equal(r.trades,0);assert.equal(r.winRate,null);assert.equal(r.empiricalBreakEven,null);
});
test('every actual virtual entry is after its signal and multi-market positions cannot overlap',()=>{
 const a=trending(1800);
 const markets={R_100:{bars:a,quote:quote()},R_25:{bars:a,quote:quote()}},r=replay(markets,IDS[1],epoch,epoch+1800*60);
 assert.ok(r.trades>0);
 for(const t of r.history){assert.equal(t.opened_at,t.signal_at);assert.ok(t.closed_at>t.opened_at);assert.equal(t.stake,1);}
 for(let i=1;i<r.history.length;i++)assert.ok(r.history[i].opened_at>=r.history[i-1].closed_at);
 const stress=replay(markets,IDS[1],epoch,epoch+1800*60,{stress:true});assert.equal(stress.trades,r.trades);assert.ok(stress.history.every((t,i)=>t.profit<=r.history[i].profit));
});
test('unknown results at a boundary are retained as unresolved, without invented P/L',()=>{
 const a=trending(600);
 const r=replay({R_100:{bars:a,quote:quote()}},IDS[1],epoch+590*60,epoch+593*60);assert.ok(r.unresolved.length>0);assert.equal(r.trades,0);assert.equal(r.net,0);
});
test('a positive high win rate cannot qualify negative net results',()=>{
 const history=Array.from({length:120},(_,i)=>({opened_at:epoch+i*4000,closed_at:epoch+i*4000+60,profit:i%10===0?-1:.05})),r=summarize(history,{unresolved:[]});assert.ok(r.winRate>.8);assert.ok(r.net<0);
 const a=assess(r,r,r,[epoch,epoch+7*86400],protocol.selection);assert.equal(a.eligible,false);assert.ok(a.reasons.some(x=>x.includes('net')));
});
test('qualification is not hard-coded NO TRADE; strong constructed controls can pass',()=>{
 const history=Array.from({length:140},(_,i)=>({opened_at:epoch+Math.floor(i/20)*86400+i%20*60,closed_at:epoch+Math.floor(i/20)*86400+i%20*60+60,profit:.1})),r=summarize(history,{unresolved:[]});
 assert.equal(assess(r,r,r,[epoch,epoch+7*86400],protocol.selection).eligible,true);assert.ok(dayLowerBound(history)>0);
});
test('test outcomes cannot influence validation selection or trigger a switch to another candidate',()=>{
 const p=structuredClone(protocol);p.periods={training:[new Date(epoch*1000).toISOString(),new Date((epoch+400*60)*1000).toISOString()],validation:[new Date((epoch+400*60)*1000).toISOString(),new Date((epoch+700*60)*1000).toISOString()],test:[new Date((epoch+700*60)*1000).toISOString(),new Date((epoch+1000*60)*1000).toISOString()]};
 const a=bars(),b=structuredClone(a);for(let i=700;i<1000;i++)Object.assign(b[i],{open:50,high:51,low:49,close:50});
 const left=evaluate({R_100:{bars:a,quote:quote()}},p),right=evaluate({R_100:{bars:b,quote:quote()}},p);
 assert.equal(left.selectedOnValidation,right.selectedOnValidation);assert.deepEqual(left.rows.map(r=>r.assessment),right.rows.map(r=>r.assessment));assert.equal(left.decision,'NO TRADE');assert.equal(left.broker_execution_authorized,false);
});
test('existing broker worker, execution, original library and website are byte-for-byte preserved',()=>{
 for(const file of['backend/chartscanner/recovery/worker.ts','backend/chartscanner/src/lib/local-rules.server.ts','backend/chartscanner/src/lib/strategy-library.server.ts','backend/routers/chart_auto.py','backend/lib/chart_strategy.py','backend/lib/deriv_demo.py','frontend/index.html','frontend/public/account.js','frontend/public/chart-auto.js'])assert.equal(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),execFileSync('git',['show','ed226a2c64651c4303fc4edb5d7b2d0271f0b17a:'+file],{encoding:'utf8'}),file);
});
