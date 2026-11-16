// No network, model or paid-provider calls. Only a documented mechanical subset
// is executable. All 17 sources remain independently listed and source-linked.
import { STRATEGY_LIBRARY } from "./strategy-library.server.ts";
import { applyScanPolicy } from "./scan-policy.server.ts";
type Bar={epoch:number;open:number;high:number;low:number;close:number};
const frames=[86400,14400,3600,900,300,60];
const labels:Record<number,string>={86400:'D1',14400:'H4',3600:'H1',900:'M15',300:'M5',60:'M1'};
const point=(g:number,b:Bar,field:string)=>({granularity:g,epoch:b.epoch,field});
const finish=(value:any)=>{const result=applyScanPolicy(value,frames.length);result.warnings=(result.warnings as string[]).filter(x=>!x.startsWith('Chart observations are AI interpretations'));return result;};

function direction(bars:Bar[]) {
 const [a,b,c]=bars.slice(-3);
 if(!a||!b||!c)return 'UNKNOWN';
 return a.high<b.high && b.high<c.high && a.low<b.low && b.low<c.low?'BUY':a.high>b.high && b.high>c.high && a.low>b.low && b.low>c.low?'SELL':'UNKNOWN';
}

export function localScan(symbol:string,data:Record<string,Bar[]>) {
 const valid=frames.every(g=>Array.isArray(data[g]) && data[g].length>=4 && data[g].every(b=>Number.isInteger(b.epoch) && [b.open,b.high,b.low,b.close].every(v=>Number.isFinite(v)&&v>0) && b.low<=Math.min(b.open,b.close) && b.high>=Math.max(b.open,b.close)));
 const evaluations=STRATEGY_LIBRARY.map(s=>({strategy_id:s.id,status:'unverifiable',direction:null,source_pages:[],evidence_ids:[],missing_conditions:[
  ['candle-range-theory','giant-killer'].includes(s.id)?'The documented previous-day raid/reversal pattern is not confirmed.':'Preserved source; its discretionary criteria are not fully specified as executable local rules.']}));
 const base:any={pair:symbol,analysis_method:'local_ohlc_rules',verdict:'WAIT',chart_readable:valid,structure_clear:false,consolidating:true,awaiting_confirmation:true,
  needs_more_timeframes:false,chart_images:frames.map((g,i)=>({image_index:i+1,symbol,timeframe:labels[g],readable:valid,bias:valid?direction(data[g]):'UNKNOWN'})),
  strategy_evaluations:evaluations,evidence:[],local_diagnostics:[],wait_summary:'WAIT — original M15/H1 pattern not complete.',warnings:['Local mechanical subset, not an exact replacement for every discretionary PDF interpretation. No AI credits are used.'],multiplier_plan:null};
 if(!valid)return finish(base);
 const day=data[86400].at(-1)!;
 // Giant Killer expressly restricts its patterns to M15/H1. Do not invent an
 // M1 version. M1 scheduling only permits an entry at the just-closed source bar.
 for(const g of [900,3600]) {
  if(data[g].length<5)continue;
  const [range,raid,a,b,c]=data[g].slice(-5),lastMinute=data[60].at(-1)!;
  if(c.epoch+g!==lastMinute.epoch+60) {
   base.local_diagnostics.push({timeframe:labels[g],reason:'waiting_for_source_close',next_source_close:Math.floor((lastMinute.epoch+60)/g)*g+g});continue;
  }
  if(raid.epoch<day.epoch+86400){base.local_diagnostics.push({timeframe:labels[g],reason:'previous_day_context_not_ready'});continue;}
  // Touching/testing a level includes crossing it and closing on the valid
  // side. Exact OHLC equality was an extra restriction, not a PDF requirement.
  const support=range.low<=day.low && range.close>day.low;
  const resistance=range.high>=day.high && range.close<day.high;
  const bullRaid=support && raid.low<range.low && raid.close>day.low && raid.close<range.high;
  const bearRaid=resistance && raid.high>range.high && raid.close<day.high && raid.close>range.low;
  const bull=bullRaid && [a,b,c].every(x=>x.close>x.open) && c.close>raid.high && c.high<range.high && direction([a,b,c])==='BUY';
  const bear=bearRaid && [a,b,c].every(x=>x.close<x.open) && c.close<raid.low && c.low>range.low && direction([a,b,c])==='SELL';
  base.local_diagnostics.push({timeframe:labels[g],reason:!support&&!resistance?'prior_day_level_not_tested':!bullRaid&&!bearRaid?'raid_and_close_back_missing':!bull&&!bear?'reversal_or_structure_confirmation_missing':'pattern_confirmed'});
  if(!bull&&!bear)continue;
  const side=bull?'BUY':'SELL',index=frames.indexOf(g)+1;
  const evidence=[
   {id:'day-range',chart_event_id:'D1:'+day.epoch,kind:'pattern',status:'confirmed',observation:'Previous closed trading-day high/low range is present.',image_index:1,timeframe:'D1',sources:[{strategy_id:'candle-range-theory',page:4}]},
   {id:'crt-range',chart_event_id:labels[g]+':'+range.epoch,kind:'pattern',status:'confirmed',observation:'A closed CRT range candle tested the previous-day extreme and closed on the valid side.',image_index:index,timeframe:labels[g],sources:[{strategy_id:'candle-range-theory',page:bull?2:3}]},
   {id:'raid',chart_event_id:labels[g]+':'+raid.epoch,kind:'liquidity_sweep',status:'confirmed',observation:'Price raided the previous-day extreme and closed back inside.',image_index:index,timeframe:labels[g],sources:[{strategy_id:'candle-range-theory',page:bull?2:3},{strategy_id:'giant-killer',page:bull?19:17}]},
   {id:'confirmation',chart_event_id:labels[g]+':'+c.epoch,kind:'body_close_bos',status:'confirmed',candle_closed:true,body_close_confirmed:true,observation:'Three opposite-colour candles reversed the raid; the final body closed beyond its opposite extreme.',image_index:index,timeframe:labels[g],sources:[{strategy_id:'candle-range-theory',page:bull?2:3},{strategy_id:'giant-killer',page:bull?19:17}]}];
  for(const e of evaluations)if(['candle-range-theory','giant-killer'].includes(e.strategy_id))Object.assign(e,{status:'match',direction:side,source_pages:e.strategy_id==='giant-killer'?[bull?19:17]:[bull?2:3,4],evidence_ids:evidence.map(x=>x.id),missing_conditions:[]});
  Object.assign(base,{verdict:side+'_NOW',structure_clear:true,clean_structure:true,consolidating:false,awaiting_confirmation:false,evidence,
   multiplier_plan:{direction:side,entry_low:point(g,bull?raid:c,bull?'high':'low'),entry_high:point(g,bull?c:raid,bull?'high':'low'),stop_anchor:point(g,raid,bull?'low':'high'),target_anchor:point(g,range,bull?'high':'low'),source_strategy_ids:['candle-range-theory','giant-killer']},
   execution_scope:'CRT exits with the documented Giant Killer M15/H1 reversal-entry pattern. Numeric zone-strength/news rules from other sources are not invented.'});
  return finish(base);
 }
 const active=base.local_diagnostics.find((d:any)=>d.reason!=='waiting_for_source_close');
 const messages:Record<string,string>={prior_day_level_not_tested:'the prior-day level has not been tested',raid_and_close_back_missing:'the required raid and close-back are missing',reversal_or_structure_confirmation_missing:'the reversal/body-close structure is not confirmed',previous_day_context_not_ready:'the new trading-day context is incomplete'};
 base.wait_summary=active?'WAIT — M15/H1 preset: '+(messages[active.reason] || 'no complete pattern')+'.':'WAIT — this preset enters at M15/H1 closes, not on every M1 check.';
 return finish(base);
}
