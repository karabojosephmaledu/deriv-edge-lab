const{test}=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),sandbox={};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../frontend/public/matches-simulator.js'),'utf8'),sandbox);const M=sandbox.MatchesSimulation;
const cfg={preset:'fixed',stake:1,digit:7,symbol:'R_100',target:null,loss:null};
const response=(stake=1)=>({proposal:{id:'public-test-quote',ask_price:stake,payout:Math.round(stake*8.33*100)/100}});
function harness(patch={}){
 const e=new M.Engine({...cfg,...patch});e.start();let epoch=1000;
 return{e,tick(d=7,q){epoch+=2;return e.feed({symbol:'R_100',price:100+d/100,pip:2,epoch},q,10000);},quote(){return M.quote(response(e.stage().stake),e.stage().stake,'R_100',7,10000);}};
}
test('Matches enters after its quote and settles on the following tick, not the entry digit',()=>{
 const a=harness();assert.equal(a.tick(7,a.quote()).type,'opened');assert.equal(a.e.trades,0);
 assert.equal(a.tick(2).type,'settled');assert.equal(a.e.losses,1);assert.equal(a.e.net,-100);
 a.tick(2,a.quote());a.tick(7);assert.equal(a.e.wins,1);assert.equal(a.e.net,633);
});
test('public quote validation rejects missing, fabricated, mismatched and malformed prices',()=>{
 for(const r of [{},{proposal:{id:'x',ask_price:true,payout:8.33}},{proposal:{id:'x',ask_price:2,payout:8.33}},{proposal:{id:'x',ask_price:1,payout:1}},{proposal:{id:'x',ask_price:1,payout:Infinity}},{proposal:{id:'x',ask_price:1,payout:8.333}},{...response(),echo_req:{contract_type:'DIGITDIFF'}}])assert.throws(()=>M.quote(r,1,'R_100',7,10000));
 const a=harness();a.tick(7);assert.equal(a.e.pending,null);
 a.tick(7,{...a.quote(),received:-1});assert.equal(a.e.pending,null);
 a.tick(7,{...a.quote(),gross:Infinity});assert.equal(a.e.pending,null);
});
test('duplicate, delayed and other-market observations cannot settle or duplicate a result',()=>{
 const a=harness();a.tick(7,a.quote());
 for(const t of [{symbol:'R_100',price:100.07,pip:2,epoch:1002},{symbol:'R_100',price:100.07,pip:2,epoch:1001},{symbol:'R_25',price:100.07,pip:2,epoch:1004}])assert.equal(a.e.feed(t),null);
 assert.equal(a.e.trades,0);a.tick(7);a.e.feed({symbol:'R_100',price:100.07,pip:2,epoch:1004});assert.equal(a.e.wins,1);
});
test('a target reached while paused finishes the session rather than resuming entries',()=>{
 const a=harness({target:7});a.tick(1,a.quote());a.e.pause();a.tick(7);assert.equal(a.e.net,733);assert.equal(a.e.status,'done');a.e.start();assert.equal(a.e.status,'done');assert.equal(a.e.pending,null);
});
test('Stop waits for one pending virtual settlement and cannot restart its old session',()=>{
 const a=harness();a.tick(1,a.quote());a.e.stop();assert.equal(a.e.status,'stopping');a.e.start();assert.equal(a.e.status,'stopping');a.tick(2);assert.equal(a.e.status,'done');assert.equal(a.e.net,-100);
});
test('loss budgets reserve the full next stake and stop paused settlements at the limit',()=>{
 const a=harness({loss:1});a.tick(1,a.quote());a.e.pause();a.tick(1);assert.equal(a.e.status,'done');assert.equal(a.e.net,-100);
 const b=harness({loss:.5});b.tick(7,b.quote());assert.equal(b.e.pending,null);assert.equal(b.e.status,'done');assert.equal(b.e.net,0);
});
test('missing ticks, precision changes and disconnects are unknown rather than invented wins or refunds',()=>{
 for(const cause of ['gap','precision','disconnect']){
  const a=harness();a.tick(7,a.quote());
  if(cause==='disconnect')a.e.interrupt('Disconnected');else a.e.feed({symbol:'R_100',price:100.07,pip:cause==='precision'?3:2,epoch:cause==='gap'?1006:1004});
  assert.equal(a.e.unknown,1);assert.equal(a.e.trades,0);assert.equal(a.e.net,0);assert.equal(a.e.status,'done');assert.equal(a.e.history[0].profit,null);
 }
});
test('fixed stakes never increase after wins or losses',()=>{
 const a=harness({stake:2});for(const d of [1,2,7,7,1]){a.tick(1,a.quote());a.tick(d);assert.equal(a.e.stage().stake,2);}assert.ok(a.e.history.every(r=>r.ask===200));
});
test('Video Growth uses all four exact thresholds and steps down after a fall',()=>{
 const a=harness({preset:'growth'});for(const [level,stake,index]of [[47,1,0],[99.99,1,0],[100,2,1],[199.99,2,1],[200,5,2],[499.99,5,2],[500,10,3],[499,5,2],[199,2,1],[99,1,0]]){a.e.net=Math.round((level-47)*100);assert.deepEqual(JSON.parse(JSON.stringify(a.e.stage())),{level,stake,index,to:M.STAGES[index].to});}
});
test('Video Growth stops at its final milestone or when it cannot fund a virtual stake',()=>{
 const a=harness({preset:'growth'});a.e.net=95300;a.tick(7,a.quote());assert.equal(a.e.status,'done');assert.equal(a.e.pending,null);
 const b=harness({preset:'growth'});b.e.net=-4650;b.tick(7,b.quote());assert.equal(b.e.status,'done');assert.equal(b.e.pending,null);
});
test('uniform ten-percent Matches outcomes with 8.33x gross return still lose money',()=>{
 const a=harness();for(let i=0;i<100;i++){a.tick(1,a.quote());a.tick(i%10===0?7:1);}assert.equal(a.e.wins,10);assert.equal(a.e.losses,90);assert.equal(a.e.net,-1670);
});
test('refresh restores paused sessions and unresolved open entries exactly once',()=>{
 const a=harness();a.tick(1,a.quote());a.tick(7);const restored=M.Engine.restore(a.e.snapshot());assert.equal(restored.status,'paused');assert.equal(restored.net,733);
 const b=harness();b.tick(1,b.quote());const unknown=M.Engine.restore(b.e.snapshot());assert.equal(unknown.unknown,1);assert.equal(unknown.status,'done');assert.equal(M.Engine.restore(unknown.snapshot()).unknown,1);
 assert.throws(()=>M.Engine.restore({...a.e.snapshot(),net:NaN}));assert.throws(()=>M.Engine.restore({...a.e.snapshot(),sequence:500}));
});
test('session configuration rejects invalid digits, non-cent stakes and zero/negative limits',()=>{
 for(const patch of [{digit:10},{digit:true},{stake:true},{stake:.351},{stake:.1},{target:0},{loss:-1},{preset:'martingale'},{symbol:'unknown'}])assert.throws(()=>new M.Engine({...cfg,...patch}));
});

test('saved P/L must reconcile with its actual virtual outcomes',()=>{
 const a=harness();a.tick(1,a.quote());a.tick(7);
 assert.throws(()=>M.Engine.restore({...a.e.snapshot(),net:100000}));
 assert.throws(()=>M.Engine.restore({...a.e.snapshot(),history:[]}));
});
