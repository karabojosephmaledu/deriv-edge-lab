// Pure, virtual-only M1 research. No network, credentials, account or order APIs.
// These explicit experimental definitions do not claim provenance from the PDFs.
export const IDS=Object.freeze(['m1-pullback','m1-breakout']);
export const PARAMETERS=Object.freeze({fast:20,slow:50,atr:14,lookback:20,reward:1.5,maxMinutes:5,stake:1,warmup:360});
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export const cents=n=>Math.round((n+Number.EPSILON)*100)/100;
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export function checkedBars(input){
 if(!Array.isArray(input))throw Error('Missing market candles');
 return input.map((b,i)=>{
  if(!b||!Number.isInteger(b.epoch)||b.epoch%60||i&&b.epoch<=input[i-1].epoch||
    !['open','high','low','close'].every(k=>finite(b[k])&&b[k]>0)||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close))throw Error('Invalid or unordered closed candles');
  return {...b};
 });
}
function ema(values,n){let e=null;return values.map((v,i)=>{e=e===null?v:e+2/(n+1)*(v-e);return i<n-1?null:e;});}
export function prepare(input){
 const bars=checkedBars(input),closes=bars.map(b=>b.close),fast=ema(closes,20),slow=ema(closes,50);
 const atr=bars.map((b,i)=>Math.max(b.high-b.low,i?Math.abs(b.high-bars[i-1].close):0,i?Math.abs(b.low-bars[i-1].close):0));
 const rolling=atr.map((_,i)=>i>=13?mean(atr.slice(i-13,i+1)):null);
 const fives=[];let group=[];
 for(const b of bars){
  if(group.length&&Math.floor(group[0].epoch/300)!==Math.floor(b.epoch/300))group=[];
  group.push(b);
  if(group.length===5&&group[0].epoch%300===0&&group.every((v,i)=>v.epoch===group[0].epoch+i*60)){
   fives.push({epoch:group[0].epoch,close:group[4].close});group=[];
  }
 }
 const ffast=ema(fives.map(b=>b.close),20),fslow=ema(fives.map(b=>b.close),50),bias=[];let j=-1;
 for(const b of bars){while(j+1<fives.length&&fives[j+1].epoch+300<=b.epoch+60)j++;bias.push(j>=49?(ffast[j]>fslow[j]?'BUY':ffast[j]<fslow[j]?'SELL':null):null);}
 return {bars,fast,slow,atr:rolling,bias};
}
export function signal(prepared,i,id){
 if(!IDS.includes(id))throw Error('Unknown M1 preset');
 const {bars,fast,slow,atr,bias}=prepared,b=bars[i],p=bars[i-1];
 if(!b||i<PARAMETERS.warmup||!atr[i]||!bias[i]||bars[i-PARAMETERS.warmup].epoch!==b.epoch-PARAMETERS.warmup*60)return null;
 const buy=fast[i]>slow[i]&&bias[i]==='BUY',sell=fast[i]<slow[i]&&bias[i]==='SELL';
 let side=null,stop=null;
 if(id==='m1-pullback'){
  if(buy&&p.low<=fast[i-1]&&p.close<=fast[i-1]&&b.close>fast[i]&&b.close>b.open&&b.high>p.high){side='BUY';stop=Math.min(p.low,b.low);}
  if(sell&&p.high>=fast[i-1]&&p.close>=fast[i-1]&&b.close<fast[i]&&b.close<b.open&&b.low<p.low){side='SELL';stop=Math.max(p.high,b.high);}
 }else{
  const prior=bars.slice(i-20,i),high=Math.max(...prior.map(x=>x.high)),low=Math.min(...prior.map(x=>x.low));
  if(buy&&b.close>high&&b.close>b.open){side='BUY';stop=Math.min(...bars.slice(i-2,i+1).map(x=>x.low));}
  if(sell&&b.close<low&&b.close<b.open){side='SELL';stop=Math.max(...bars.slice(i-2,i+1).map(x=>x.high));}
 }
 if(!side)return null;
 return {id,symbol:prepared.symbol,side,signal_at:b.epoch+60,reference:b.close,stop,
  score:Math.abs(fast[i]-slow[i])/atr[i],evidence:['Closed M1 trend','Closed M5 trend agreement',id==='m1-pullback'?'EMA pullback and reclaim':'20-bar body-close breakout'],experimental:true,broker_execution_authorized:false};
}
export function quoteScenario(raw,side){
 const q=raw?.[side];
 if(!q||!finite(q.commission)||q.commission<0||!finite(q.multiplier)||q.multiplier<=0||q.ask_price!==1||!Number.isInteger(raw.pip)||raw.pip<0||raw.pip>10)return null;
 for(const kind of ['stop_loss','take_profit']){const l=q.validation_params?.[kind];if(!l||!finite(l.min)||!finite(l.max)||l.min<0||l.max<l.min)return null;}
 return {...q,increment:10**-raw.pip};
}
function plan(sig,bar,raw,stress){
 const q=quoteScenario(raw,sig.side);if(!q)return {rejected:'missing_quote'};
 const sign=sig.side==='BUY'?1:-1,entry=bar.open+sign*q.increment,stop=sig.stop-sign*q.increment;
 const risk=sign*(entry-stop);if(risk<=0)return {rejected:'gapped_entry'};
 const target=entry+sign*PARAMETERS.reward*risk,commission=q.commission;
 const plannedLoss=cents(q.multiplier*risk/entry+commission),plannedGain=cents(q.multiplier*PARAMETERS.reward*risk/entry-commission);
 const sl=q.validation_params.stop_loss,tp=q.validation_params.take_profit;
 // Base provider limits decide feasibility in both scenarios. Stress must not
 // improve a study by selectively deleting its expensive losing positions.
 const baseEntry=bar.open+sign*q.increment,baseRisk=sign*(baseEntry-stop);
 const baseLoss=cents(q.multiplier*baseRisk/baseEntry+q.commission),baseGain=cents(q.multiplier*PARAMETERS.reward*baseRisk/baseEntry-q.commission);
 if(baseRisk<=0||baseLoss<sl.min||baseLoss>Math.min(1,sl.max)||baseGain<tp.min||baseGain>tp.max)return {rejected:'provider_exit_limits'};
 const position={sig,sign,entry,stop,target,commission,multiplier:q.multiplier,increment:q.increment,opened_at:bar.epoch,plannedLoss,plannedGain,bars:0};
 position.plannedLoss=-priceReturn(position,stop,stress).profit;position.plannedGain=priceReturn(position,target,stress).profit;
 return position;
}
function priceReturn(p,price,stress){
 const exit=price-p.sign*p.increment*(stress?2:1),entry=p.entry+p.sign*p.increment*(stress?1:0),commission=p.commission*(stress?2:1);
 return {exit,entry,commission,profit:Math.max(-1,cents(p.multiplier*p.sign*(exit-entry)/entry-commission))};
}
export function settle(position,bar,stress=false){
 const p=position,s=p.sign;
 const stopOut=p.entry*(1-s*(1-p.commission)/p.multiplier);
 const stop=s===1?Math.max(p.stop,stopOut):Math.min(p.stop,stopOut);
 let price=null,reason=null,ambiguous=false;
 if(s*(bar.open-stop)<=0){price=bar.open;reason='gap_stop';}
 else if(s*(bar.open-p.target)>=0){price=p.target;reason='target';}
 else{
  const stopped=s===1?bar.low<=stop:bar.high>=stop,won=s===1?bar.high>=p.target:bar.low<=p.target;
  if(stopped){price=stop;reason='stop';ambiguous=won;}
  else if(won){price=p.target;reason='target';}
  else if(p.bars+1>=PARAMETERS.maxMinutes){price=bar.close;reason='time';}
 }
 if(price===null)return null;
 const {exit,entry,commission,profit}=priceReturn(p,price,stress);
 return {id:p.sig.id,symbol:p.sig.symbol,side:p.sig.side,signal_at:p.sig.signal_at,opened_at:p.opened_at,closed_at:bar.epoch+60,
  stake:1,entry,exit,profit,commission,reason,ambiguous,plannedLoss:p.plannedLoss,plannedGain:p.plannedGain};
}
export function summarize(history,extra={}){
 const wins=history.filter(t=>t.profit>0),losses=history.filter(t=>t.profit<0);let net=0,peak=0,dd=0,streak=0,maxStreak=0;
 for(const t of history){net=cents(net+t.profit);peak=Math.max(peak,net);dd=Math.max(dd,peak-net);streak=t.profit<0?streak+1:0;maxStreak=Math.max(maxStreak,streak);}
 const aw=mean(wins.map(t=>t.profit)),al=mean(losses.map(t=>-t.profit));
 const planned=history.filter(t=>t.plannedGain>0&&t.plannedLoss>0).map(t=>t.plannedLoss/(t.plannedLoss+t.plannedGain));
 return {trades:history.length,wins:wins.length,losses:losses.length,breakEvenTrades:history.length-wins.length-losses.length,winRate:history.length?wins.length/history.length:null,
  net,maxDrawdown:cents(dd),maxLossStreak:maxStreak,averageWin:aw,averageLoss:al,riskReward:aw!==null&&al>0?aw/al:null,
  empiricalBreakEven:aw>0&&al>0?al/(aw+al):null,profitFactor:losses.length?wins.reduce((n,t)=>n+t.profit,0)/losses.reduce((n,t)=>n-t.profit,0):null,
  plannedBreakEvenRange:planned.length?[Math.min(...planned),Math.max(...planned)]:null,
  ambiguousBars:history.filter(t=>t.ambiguous).length,history,...extra};
}
// One chronological portfolio position across all selected symbols. Entry is
// deferred until the next actual candle; no fills in the signal candle.
export function replay(markets,id,start,end,{stress=false}={}){
 const contexts=Object.entries(markets).map(([symbol,m])=>({...prepare(m.bars),symbol,quote:m.quote,index:new Map(m.bars.map((b,i)=>[b.epoch,i]))}));
 const times=[...new Set(contexts.flatMap(m=>m.bars.filter(b=>b.epoch>=start&&b.epoch<end).map(b=>b.epoch)))].sort((a,b)=>a-b);
 const history=[],unresolved=[],rejects={missing_quote:0,gapped_entry:0,provider_exit_limits:0},stats={signals:0};let position=null,pending=null,net=0,peak=0,drawdownBound=0;
 for(const time of times){
  let exited=false;
  if(pending&&!position){
   const m=contexts.find(m=>m.symbol===pending.symbol),i=m.index.get(time),bar=i===undefined?null:m.bars[i];
   if(time===pending.signal_at&&bar){const p=plan(pending,bar,m.quote,stress);if(p.rejected)rejects[p.rejected]++;else position={...p,last:time-60};}
   pending=null;
  }
  if(position){
   const m=contexts.find(m=>m.symbol===position.sig.symbol),i=m.index.get(time),bar=i===undefined?null:m.bars[i];
   if(!bar||position.last!==time-60){unresolved.push({symbol:m.symbol,opened_at:position.opened_at,reason:'missing_candles'});position=null;exited=true;}
   else{
    const p=position,s=p.sign,stopOut=p.entry*(1-s*(1-p.commission)/p.multiplier),stop=s===1?Math.max(p.stop,stopOut):Math.min(p.stop,stopOut);
    const gapStop=s*(bar.open-stop)<=0;
    const best=gapStop?bar.open:s===1?Math.min(bar.high,p.target):Math.max(bar.low,p.target);
    const worst=gapStop?bar.open:s===1?Math.max(bar.low,stop):Math.min(bar.high,stop);
    // OHLC cannot establish the intrabar order. Favourable-first peak followed
    // by the adverse bound is conservative, not a claimed exact tick drawdown.
    peak=Math.max(peak,net+priceReturn(p,best,stress).profit);
    drawdownBound=Math.max(drawdownBound,peak-net-priceReturn(p,worst,stress).profit);
    const result=settle(p,bar,stress);position.bars++;position.last=time;if(result){history.push(result);net=cents(net+result.profit);peak=Math.max(peak,net);drawdownBound=Math.max(drawdownBound,peak-net);position=null;exited=true;}
   }
  }
  if(!position&&!exited&&time+60<end){
   const signals=[];
   for(const m of contexts){const i=m.index.get(time);if(i===undefined)continue;const s=signal(m,i,id);if(s){s.symbol=m.symbol;signals.push(s);}}
   stats.signals+=signals.length;
   signals.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));pending=signals[0]||null;
  }
 }
 if(position)unresolved.push({symbol:position.sig.symbol,opened_at:position.opened_at,reason:'period_ended'});
 return summarize(history,{unresolved,rejects,...stats,maxEquityDrawdownBound:cents(drawdownBound),drawdownMethod:'Conservative favourable-first/adverse-second OHLC bound, including open positions; maxDrawdown is settled equity only',pricing:'Current public commission/limits scenario; hypothetical OHLC fills, not actual contracts'});
}
export function dayLowerBound(history,{samples=2000,alpha=.025,seed=20261116}={}){
 const groups=new Map();for(const t of history){const d=Math.floor(t.closed_at/86400);groups.set(d,(groups.get(d)||0)+t.profit);}
 const days=[...groups.values()];if(days.length<5)return null;
 let state=seed>>>0;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
 const sums=Array.from({length:samples},()=>{let n=0;for(let i=0;i<days.length;i++)n+=days[Math.floor(random()*days.length)];return n/days.length;}).sort((a,b)=>a-b);
 return sums[Math.floor(alpha*samples)];
}
export function assess(training,validation,stress,period,policy){
 const reasons=[];
 if(training.trades<policy.minimum_training_trades||validation.trades<policy.minimum_validation_trades)reasons.push('Insufficient training/validation trades');
 if(training.net<=0||validation.net<=0||stress.net<=0)reasons.push('Training, validation and cost-stress net must all be positive');
 if(Math.max(validation.maxDrawdown,validation.maxEquityDrawdownBound||0)>policy.maximum_drawdown_stakes)reasons.push('Validation drawdown exceeds risk limit');
 if(training.unresolved.length||validation.unresolved.length||stress.unresolved.length)reasons.push('Unresolved positions prevent qualification');
 const days=new Set(validation.history.map(t=>Math.floor(t.closed_at/86400))).size;
 if(days<policy.minimum_validation_days)reasons.push('Too few validation days');
 const blocks=Array.from({length:policy.validation_blocks},(_,i)=>validation.history.filter(t=>t.opened_at>=period[0]+(period[1]-period[0])*i/policy.validation_blocks&&t.opened_at<period[0]+(period[1]-period[0])*(i+1)/policy.validation_blocks));
 if(blocks.some(b=>!b.length||b.reduce((n,t)=>n+t.profit,0)<=0))reasons.push('Not positive in every chronological validation block');
 const lowerBound=dayLowerBound(validation.history,{samples:policy.bootstrap_samples,alpha:policy.familywise_alpha/IDS.length,seed:policy.seed});
 if(lowerBound===null||lowerBound<=0)reasons.push('Daily-block net-return lower bound is not positive');
 return {eligible:reasons.length===0,reasons,lowerBound,validationDays:days,blockNets:blocks.map(b=>cents(b.reduce((n,t)=>n+t.profit,0)))};
}
export function evaluate(markets,protocol){
 const periods=Object.fromEntries(Object.entries(protocol.periods).map(([k,v])=>[k,v.map(x=>Date.parse(x)/1000)]));
 const rows=IDS.map(id=>{
  const training=replay(markets,id,...periods.training),validation=replay(markets,id,...periods.validation),stress=replay(markets,id,...periods.validation,{stress:true});
  return {id,training,validation,stress,assessment:assess(training,validation,stress,periods.validation,protocol.selection)};
 });
 const ranked=rows.filter(r=>r.assessment.eligible).sort((a,b)=>b.validation.net-a.validation.net||a.validation.maxDrawdown-b.validation.maxDrawdown||a.id.localeCompare(b.id));
 const selected=ranked[0]?.id||null;
 // The candidate is frozen before test results are read. A failed test cannot
 // cause a switch to whichever alternative happened to win in the test.
 for(const r of rows){r.test=replay(markets,r.id,...periods.test);r.testStress=replay(markets,r.id,...periods.test,{stress:true});}
 const chosen=rows.find(r=>r.id===selected),confirmed=chosen&&chosen.test.net>0&&chosen.testStress.net>0&&chosen.test.trades>=protocol.selection.minimum_validation_trades&&Math.max(chosen.test.maxDrawdown,chosen.test.maxEquityDrawdownBound)<=protocol.selection.maximum_drawdown_stakes&&!chosen.test.unresolved.length;
 return {version:protocol.version,selectedOnValidation:selected,decision:confirmed?'VIRTUAL RESEARCH CANDIDATE ONLY':'NO TRADE',broker_execution_authorized:false,
  reason:!selected?'No candidate passed the predeclared training/validation criteria':!confirmed?'The validation-selected candidate did not confirm on the untouched test':'Historical scenario evidence only; authenticated execution and forward profitability remain unverified',rows};
}
