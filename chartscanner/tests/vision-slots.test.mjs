import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {loadVisionSlots,visionModels,runVisionSlots,VisionSlotsError,createVisionProbe} from '../../backend/chartscanner/src/lib/vision-slots.server.ts';

function quadrantNames(uri){
 const b=Buffer.from(uri.split(',')[1],'base64');let at=8,parts=[];
 while(at<b.length){const n=b.readUInt32BE(at),kind=b.toString('ascii',at+4,at+8);if(kind==='IDAT')parts.push(b.subarray(at+8,at+8+n));at+=12+n;}
 const raw=inflateSync(Buffer.concat(parts));const colors={'255,0,0':'red','0,0,255':'blue','255,255,0':'yellow','0,255,0':'green','0,0,0':'black','255,255,255':'white'};
 return [[8,8],[24,8],[8,24],[24,24]].map(([x,y])=>colors[[...raw.subarray(y*97+1+x*3,y*97+4+x*3)].join(',')]);
}
function response(content,finish_reason='stop'){return new Response(JSON.stringify({choices:[{message:{content},finish_reason}]}),{status:200,headers:{'Content-Type':'application/json'}});}
function mock(calls,{rejectKey='',truncateKey='',badProbe=false}={}){
 return async(url,init)=>{
  const body=init.body?JSON.parse(init.body):{};calls.push({url,body,headers:init.headers});
  if(init.headers.Authorization==='Bearer '+rejectKey)return new Response('do not expose provider key: '+rejectKey,{status:429});
  if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'qwen-text',architecture:{input_modalities:['text']}},{id:'vision-real',architecture:{input_modalities:['text','image']}}]}));
  if(body.messages.length===1){const uri=body.messages[0].content.find(p=>p.type==='image_url').image_url.url;return response(badProbe?'OK':JSON.stringify(quadrantNames(uri)));}
  return response('{"verdict":"WAIT"}',init.headers.Authorization==='Bearer '+truncateKey?'length':'stop');
 };
}
const options={system:'Original rules. No trade when unsupported.',messages:[{role:'user',content:[{type:'text',text:'Read the chart.'},{type:'image',image:createVisionProbe().image}]}]};

test('six independent environment slots allow the same provider with different credentials',()=>{
 const env={};for(let i=1;i<=7;i++){env[`CHART_AI_SLOT_${i}_PROVIDER`]='openai';env[`CHART_AI_SLOT_${i}_API_KEY`]='controlled-key-'+i;}
 assert.equal(loadVisionSlots(env).length,6);
 assert.equal(loadVisionSlots(env)[5].slot,6);
});
test('metadata saying text-only overrides any model-name heuristic',()=>{
 assert.deepEqual(visionModels([{id:'gpt-4o-looking-text',architecture:{input_modalities:['text']}},{id:'actual-model',architecture:{input_modalities:['text','image']}}],'openrouter'),['actual-model']);
});
test('an unsupported first slot cannot disable a valid later slot',()=>{
 const slots=loadVisionSlots({CHART_AI_SLOT_1_PROVIDER:'unknown',CHART_AI_SLOT_1_API_KEY:'bad-test',CHART_AI_SLOT_2_PROVIDER:'openai',CHART_AI_SLOT_2_API_KEY:'good-test'});
 assert.equal(slots.length,1);assert.equal(slots[0].slot,2);
});
test('new OpenAI models use their supported completion-token parameter',async()=>{
 const calls=[];await runVisionSlots(options,[{slot:1,provider:'openai',key:'modern-model-test',model:'gpt-5-test'}],mock(calls));
 assert.equal(calls.at(-1).body.max_completion_tokens,10000);
 assert.equal(calls.at(-1).body.temperature,undefined);assert.equal(calls.at(-1).body.max_tokens,undefined);
});
test('randomized image probe has four actual colored quadrants and no answer in text',()=>{
 for(let i=0;i<4;i++){const p=createVisionProbe();assert.deepEqual(quadrantNames(p.image),p.expected);assert.equal(new Set(p.expected).size,4);}
});
test('automatic discovery selects an image model and verifies it by reading an image',async()=>{
 const calls=[];const r=await runVisionSlots(options,[{slot:1,provider:'openrouter',key:'discover-private-test',model:''}],mock(calls));
 assert.equal(r.model,'vision-real');assert.equal(r.text,'{"verdict":"WAIT"}');assert.equal(calls.length,3);assert.ok(calls[1].body.messages[0].content.some(p=>p.type==='image_url'));
});
test('a provider quota failure falls back without leaking its key or error body',async()=>{
 const calls=[];const r=await runVisionSlots(options,[{slot:1,provider:'openai',key:'first-controlled',model:'gpt-4o-mini'},{slot:2,provider:'gemini',key:'second-controlled',model:'gemini-test'}],mock(calls,{rejectKey:'first-controlled'}));
 assert.equal(r.slot,2);assert.ok(!JSON.stringify(r).includes('controlled'));assert.ok(calls.every(c=>!c.url.includes('controlled')));
});
test('a text-only OK probe never counts as working vision',async()=>{
 await assert.rejects(()=>runVisionSlots(options,[{slot:1,provider:'openai',key:'bad-probe-key',model:'gpt-4o-mini'}],mock([],{badProbe:true})),VisionSlotsError);
});
test('a truncated strategy result falls back rather than accepting partial JSON',async()=>{
 const r=await runVisionSlots(options,[{slot:1,provider:'openai',key:'truncate-controlled',model:'gpt-4o-mini'},{slot:6,provider:'openai',key:'complete-controlled',model:'gpt-4o-mini'}],mock([],{truncateKey:'truncate-controlled'}));
 assert.equal(r.slot,6);
});
test('malformed chart JSON also falls back to the next available slot',async()=>{
 const delegate=mock([]);
 const fetcher=async(url,init)=>{
  const body=init.body?JSON.parse(init.body):{};
  if(init.headers.Authorization==='Bearer malformed-test' && body.messages?.length>1)return response('unstructured analysis');
  return delegate(url,init);
 };
 const result=await runVisionSlots(options,[{slot:1,provider:'openai',key:'malformed-test',model:'gpt-4o-mini'},{slot:2,provider:'openai',key:'json-test',model:'gpt-4o-mini'}],fetcher);
 assert.equal(result.slot,2);
});
test('missing configured slots fails closed and never calls a paid provider',async()=>{
 let calls=0;await assert.rejects(()=>runVisionSlots(options,[],async()=>{calls++;throw new Error();}),VisionSlotsError);assert.equal(calls,0);
});
test('arbitrary image URLs cannot exfiltrate private charts through a slot',async()=>{
 const calls=[];await assert.rejects(()=>runVisionSlots({...options,messages:[{role:'user',content:[{type:'image',image:'http://internal.test/private'}]}]},[{slot:1,provider:'openai',key:'invalid-image-controlled',model:'gpt-4o-mini'}],mock(calls)),VisionSlotsError);
 assert.equal(calls.length,1); // The harmless probe ran; the invalid analysis image was rejected locally.
});
