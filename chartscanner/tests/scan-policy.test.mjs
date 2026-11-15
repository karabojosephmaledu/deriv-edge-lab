import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScanPolicy, confidenceScore } from '../../backend/chartscanner/src/lib/scan-policy.server.ts';
import { STRATEGY_LIBRARY } from '../../backend/chartscanner/src/lib/strategy-library.server.ts';
import { buildStrategyCorpus, SYSTEM_PROMPT } from '../../backend/chartscanner/src/lib/analyzer-prompt.server.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runChartScan } from '../../backend/chartscanner/src/lib/scan-engine.server.ts';
import { createVisionProbe } from '../../backend/chartscanner/src/lib/vision-slots.server.ts';

function fixture(n=8, votes=3) {
 const ids=['structure-first','carlfx-blueprint','candle-range-theory'];
 const kinds=['structure','body_close_bos','choch','liquidity_sweep','order_block','supply_demand','retest','engulfing','fvg','trendline','ema','rejection'];
 return {verdict:'BUY_NOW',chart_readable:true,structure_clear:true,clean_structure:true,
  consolidating:false,awaiting_confirmation:false,needs_more_timeframes:false,risk_reward:3,
  chart_images:[{image_index:1,symbol:'R_100',timeframe:'H1',bias:'BUY',readable:true},{image_index:2,symbol:'R_100',timeframe:'M15',bias:'BUY',readable:true}],
  evidence:Array.from({length:n},(_,i)=>({id:'e'+i,chart_event_id:'event'+i,kind:kinds[i%kinds.length],status:'confirmed',observation:'Visible event '+i,image_index:1,timeframe:'H1',sources:[{strategy_id:'structure-first',page:11}],candle_closed:true,body_close_confirmed:true})),
  strategy_evaluations:STRATEGY_LIBRARY.map(s=>({strategy_id:s.id,status:ids.slice(0,votes).includes(s.id)?'match':'not_applicable',direction:'BUY',source_pages:[1],evidence_ids:['e0'],missing_conditions:[]})),
  pattern_validation:{valid:true,complete:true},entry:{direction:'BUY',stop_loss:'98.00'},warnings:[]};
}

test('exact original scoring formula and clamp, with no rough-map override',()=>{
 assert.equal(confidenceScore(8,true,3,false,'BUY_NOW'),90);
 assert.equal(confidenceScore(12,true,3,false,'BUY_NOW'),100);
 assert.equal(confidenceScore(3,false,2,false,'BUY_NOW'),45);
 assert.equal(confidenceScore(8,true,3,true,'WAIT'),55);
 assert.equal(confidenceScore(0,false,0,false,'INVALID_SETUP'),0);
});
test('high conviction requires three entry votes and eight cited confirmations',()=>{
 const r=applyScanPolicy(fixture(),2); assert.equal(r.verdict,'BUY_NOW');assert.equal(r.policy_audit.conviction,'high');assert.equal(r.confidence_score,90);assert.equal(r.broker_execution_authorized,false);
});
test('two strategies with clear structure and three confirmations remain medium',()=>{
 const r=applyScanPolicy(fixture(3,2),2);assert.equal(r.verdict,'BUY_NOW');assert.equal(r.policy_audit.conviction,'medium');
});
test('fewer than three genuine confirmations returns WAIT, clears entry/targets',()=>{
 const r=applyScanPolicy({...fixture(2),target_area:'made up'},2);assert.equal(r.verdict,'WAIT');assert.equal(r.entry,null);assert.equal(r.target_area,null);assert.equal(r.trade_grade,'D');
});
for(const field of ['consolidating','awaiting_confirmation','needs_more_timeframes']) test(field+' blocks immediate entries',()=>{
 assert.equal(applyScanPolicy({...fixture(),[field]:true},2).verdict,'WAIT');
});
test('missing readiness cannot count as an affirmative ready signal',()=>{
 const f=fixture();delete f.consolidating;assert.equal(applyScanPolicy(f,2).verdict,'WAIT');
});
test('opposing strategy votes or explicit contradictions return WAIT',()=>{
 const f=fixture(); f.strategy_evaluations[0].direction='SELL';assert.equal(applyScanPolicy(f,2).verdict,'WAIT');
 const g=fixture();g.strategy_evaluations[2].status='contradicts';assert.equal(applyScanPolicy(g,2).verdict,'WAIT');
});
test('unreadable chart or missing actual image metadata is invalid',()=>{
 assert.equal(applyScanPolicy({...fixture(),chart_readable:false},2).verdict,'INVALID_SETUP');
 assert.equal(applyScanPolicy(fixture(),3).verdict,'INVALID_SETUP');
});
test('no matching strategy returns NO_STRATEGY_MATCH with no entry',()=>{
 const f=fixture();f.strategy_evaluations.forEach(e=>e.status='not_applicable');const r=applyScanPolicy(f,2);assert.equal(r.verdict,'NO_STRATEGY_MATCH');assert.equal(r.entry,null);
});
test('repeated events and missing/unknown source pages cannot inflate score',()=>{
 const f=fixture();f.evidence.forEach(e=>e.chart_event_id='same');assert.equal(applyScanPolicy(f,2).policy_audit.confirmations,1);
 for(const source of [{strategy_id:'invented',page:1},{strategy_id:'structure-first',page:1000}]) {
  const g=fixture();g.evidence.forEach(e=>e.sources=[source]);assert.equal(applyScanPolicy(g,2).policy_audit.confirmations,0);
 }
});
test('wick-only or unclosed BOS cannot be counted',()=>{
 for(const flag of ['candle_closed','body_close_confirmed']) {const f=fixture(3);f.evidence[1][flag]=false;assert.equal(applyScanPolicy(f,2).verdict,'WAIT');}
});
test('unknown, duplicated or missing strategy evaluations return WAIT',()=>{
 const a=fixture();a.strategy_evaluations.pop();assert.equal(applyScanPolicy(a,2).verdict,'WAIT');
 const b=fixture();b.strategy_evaluations.push(b.strategy_evaluations[0]);assert.equal(applyScanPolicy(b,2).verdict,'WAIT');
 const c=fixture();c.strategy_evaluations.push({strategy_id:'internet-strategy'});assert.equal(applyScanPolicy(c,2).verdict,'WAIT');
});
test('observation notes and Pulse cannot form standalone entry votes',()=>{
 const f=fixture();f.strategy_evaluations.forEach(e=>e.status=['pulse-entry','njat-observation','fuad-delivery'].includes(e.strategy_id)?'match':'not_applicable');assert.equal(applyScanPolicy(f,2).verdict,'WAIT');
});
test('all A+ requirements are enforced rather than merely accepting model grade',()=>{
 assert.equal(applyScanPolicy(fixture(12),2).trade_grade,'A_PLUS');
 for(const patch of [{risk_reward:2},{clean_structure:false},{pattern_validation:{valid:false}}]) assert.notEqual(applyScanPolicy({...fixture(12),...patch},2).trade_grade,'A_PLUS');
});
test('different instruments cannot be combined or earn timeframe alignment',()=>{
 const f=fixture();f.chart_images[1].symbol='EURUSD';const r=applyScanPolicy(f,2);assert.equal(r.verdict,'WAIT');assert.equal(r.policy_audit.timeframes_aligned,false);
});
test('unsupported pending order verdicts do not bypass WAIT',()=>{
 assert.equal(applyScanPolicy({...fixture(),verdict:'BUY_AFTER_RETEST'},2).verdict,'WAIT');
});
test('original source corpus includes all 16 PDFs, Pulse and untruncated tails',()=>{
 assert.equal(STRATEGY_LIBRARY.length,17);
 assert.equal(STRATEGY_LIBRARY.filter(s=>s.source.endsWith('.pdf')).reduce((n,s)=>n+s.pages,0),301);
 const corpus=buildStrategyCorpus(STRATEGY_LIBRARY.map(s=>({id:s.id,name:s.name,category:s.role,description:null,docs:[{kind:'pdf',title:s.source,extracted_text:s.content}]})));
 for(const s of STRATEGY_LIBRARY) assert.ok(corpus.includes(s.content.trim().slice(-180)),s.id);
 assert.ok(!corpus.includes('AlphaFX-Price-Action-Practical-Guide'));
 const inventory=JSON.parse(readFileSync(new URL('../../research/strategy-recovery/pdf-inventory.json',import.meta.url)));
 for(const s of STRATEGY_LIBRARY.filter(s=>s.source.endsWith('.pdf'))) {
  const original=inventory.find(v=>v.file.endsWith('/'+s.source));
  assert.equal(original.sha256,s.sha256);assert.equal(original.pages,s.pages);
 }

});
test('follow-up prompt requires fresh analysis without assuming a protected prior trade',()=>{
 assert.match(SYSTEM_PROMPT,/Never assume a prior trade exists/);
 assert.ok(!SYSTEM_PROMPT.includes('MUST set stop_loss = null'));
 assert.ok(!SYSTEM_PROMPT.includes('Rough map:'));
});
test('the actual scanner sends every recovered document through the analyzer before enforcing policy',async()=>{
 let request;
 const result=await runChartScan({userId:'controlled-test',images:[1,2].map(()=>({dataUrl:createVisionProbe().image,mime:'image/png'})),
  analyze:async options=>{request=options;return {text:JSON.stringify(fixture())};}});
 const prompt=request.messages[0].content[0].text;
 for(const s of STRATEGY_LIBRARY){assert.ok(prompt.includes(s.name));assert.ok(prompt.includes(s.content.trim().slice(-150)),s.id);}
 assert.equal(result.verdict,'BUY_NOW');assert.equal(result.confidence_score,90);
 assert.equal(result.broker_execution_authorized,false);
});
test('malformed or incomplete model output cannot become a directional scan',async()=>{
 const images=[{dataUrl:createVisionProbe().image,mime:'image/png'}];
 await assert.rejects(()=>runChartScan({userId:'controlled-test',images,analyze:async()=>({text:'not valid JSON'})}));
 const result=await runChartScan({userId:'controlled-test',images,analyze:async()=>({text:'{"verdict":"BUY_NOW","confidence_score":100}'})});
 assert.equal(result.verdict,'INVALID_SETUP');assert.equal(result.entry,null);
});
test('follow-up actually evaluates new images and cannot copy a previous directional result',async()=>{
 const result=await runChartScan({userId:'controlled-test',images:[1,2].map(()=>({dataUrl:createVisionProbe().image,mime:'image/png'})),priorAnalysis:{verdict:'SELL_NOW',entry:{stop_loss:123}},
  analyze:async options=>{assert.match(options.messages[0].content[0].text,/FOLLOW-UP: independently reevaluate/);return {text:JSON.stringify({...fixture(),consolidating:true})};}});
 assert.equal(result.verdict,'WAIT');assert.equal(result.entry,null);
});
