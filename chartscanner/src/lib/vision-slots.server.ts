// Six independent, server-environment credential slots. No key is sent to UI,
// browser storage, URLs, logs, or analysis output. Each model must read an image
// before being used; a name or text-only 'OK' response is not a vision test.
import { createHash, randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

const providers = {
  openai: { base: "https://api.openai.com/v1", hint: /^(gpt-4o|gpt-4\.1|gpt-5)/i },
  openrouter: { base: "https://openrouter.ai/api/v1", hint: /vision|claude|gemini|gpt-4o|gpt-4\.1|gpt-5/i },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", hint: /^gemini-/i },
} as const;
type Provider = keyof typeof providers;
export interface VisionSlot { slot: number; provider: Provider; key: string; model: string }
export interface SlotMessage { role: string; content: string | unknown[] }
export class VisionSlotsError extends Error {
  readonly status = 503;
  readonly attempts: Array<{slot:number; reason:string}>;
  constructor(attempts: Array<{slot:number; reason:string}>) {
    super("No configured vision slot completed the analysis. Check server-side slot configuration and model access.");
    this.attempts=attempts;
  }
}

export function loadVisionSlots(env: Record<string,string|undefined> = process.env): VisionSlot[] {
  const slots: VisionSlot[] = [];
  for (let n=1;n<=6;n++) {
    const prefix = `CHART_AI_SLOT_${n}_`;
    const provider = env[prefix+"PROVIDER"]?.trim() as Provider;
    const key = env[prefix+"API_KEY"]?.trim();
    if (!key) continue;
    // One misconfigured slot must not disable the remaining working slots.
    if (!Object.hasOwn(providers,provider)) continue;
    slots.push({slot:n,provider,key,model:env[prefix+"MODEL"]?.trim() || ""});
  }
  return slots;
}

export function visionModels(rows: unknown[], provider: Provider): string[] {
  return rows.flatMap(raw => {
    if (!raw || typeof raw!=="object") return [];
    const r=raw as Record<string,any>;
    const id=typeof r.id==='string' ? r.id : '';
    if (!id || /audio|transcrib|tts|embedding|image-gen|realtime/i.test(id)) return [];
    const declared=r.architecture?.input_modalities ?? r.input_modalities;
    // Explicitly text-only metadata always wins over a suggestive model name.
    if (Array.isArray(declared)) return declared.includes('image') ? [id] : [];
    return providers[provider].hint.test(id) ? [id] : [];
  });
}

function messages(system: string|undefined, source: SlotMessage[]) {
  return [...(system ? [{role:"system",content:system}] : []), ...source.map(m=>({
    role:m.role,
    content: typeof m.content==='string' ? m.content : m.content.map(part=>{
      const p=part as Record<string,any>;
      if(p.type==='text') return {type:'text',text:p.text};
      const data=p.type==='file'?p.data:p.type==='image'?p.image:null;
      if (typeof data!=='string' || !/^data:image\/(png|jpeg|webp);base64,/.test(data)) throw new Error('Invalid chart image');
      return {type:'image_url',image_url:{url:data}};
    }),
  }))];
}

async function request(slot:VisionSlot, path:string, init:RequestInit, fetcher:typeof fetch) {
  const response=await fetcher(providers[slot.provider].base+path, {
    ...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${slot.key}`},
    signal:AbortSignal.timeout(60_000),redirect:'error',
  });
  if(!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  return response.json();
}

async function generate(slot:VisionSlot, model:string, system:string|undefined, source:SlotMessage[], maxTokens:number, fetcher:typeof fetch) {
  const body=await request(slot,'/chat/completions', {method:'POST',body:JSON.stringify({
    model,messages:messages(system,source),
    ...(slot.provider==='openai' && /^(gpt-5|o[1-9])/.test(model)
      ? {max_completion_tokens:maxTokens} : {temperature:0,max_tokens:maxTokens}),
  })},fetcher);
  if(body.choices?.[0]?.finish_reason==='length') throw new Error('Model truncated the response');
  const content=body.choices?.[0]?.message?.content;
  if(typeof content!=='string' || !content.trim()) throw new Error('Empty model response');
  return content;
}

function pngChunk(name:string,data:Buffer) {
  const bytes=Buffer.concat([Buffer.from(name),data]); let crc=0xffffffff;
  for(const byte of bytes) { crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  const head=Buffer.alloc(4);head.writeUInt32BE(data.length);
  const tail=Buffer.alloc(4);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([head,bytes,tail]);
}

export function createVisionProbe() {
  const palette=[['red',[255,0,0]],['blue',[0,0,255]],['yellow',[255,255,0]],['green',[0,255,0]],['black',[0,0,0]],['white',[255,255,255]]] as const;
  const chosen=[...palette]; // Fisher-Yates uses cryptographic randomness.
  for(let i=chosen.length-1;i>0;i--) { const j=randomInt(i+1); [chosen[i],chosen[j]]=[chosen[j],chosen[i]]; }
  const scanlines=Buffer.alloc(32*(1+32*3));
  for(let y=0;y<32;y++) for(let x=0;x<32;x++) {
    const rgb=chosen[(y<16?0:2)+(x<16?0:1)][1];
    for(let c=0;c<3;c++) scanlines[y*97+1+x*3+c]=rgb[c];
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(32,0);ihdr.writeUInt32BE(32,4);ihdr[8]=8;ihdr[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(scanlines)),pngChunk('IEND',Buffer.alloc(0))]);
  return {image:'data:image/png;base64,'+png.toString('base64'),expected:chosen.slice(0,4).map(c=>c[0])};
}
const verified = new Map<string,number>();
export async function runVisionSlots(options:{system?:string;messages:SlotMessage[];maxOutputTokens?:number}, slots:VisionSlot[]=loadVisionSlots(), fetcher:typeof fetch=fetch) {
  const attempts: Array<{slot:number;reason:string}>=[];
  for (const slot of slots) {
    try {
      const rows=slot.model ? [slot.model] : visionModels((await request(slot,'/models',{method:'GET'},fetcher)).data ?? [],slot.provider).slice(0,3);
      if (!rows.length) throw new Error('No vision candidate was discovered');
      for(const model of rows) {
        try {
          const fingerprint=createHash('sha256').update(`${slot.provider}\0${slot.key}\0${model}`).digest('hex');
          if ((verified.get(fingerprint) ?? 0)<Date.now()) {
            const probe=createVisionProbe();
            const answer=await generate(slot,model,undefined,[{role:'user',content:[
              {type:'text',text:'Inspect the four quadrants of the attached image. Return a JSON array of four lowercase colour names in this order: top-left, top-right, bottom-left, bottom-right. No explanation.'},
              {type:'image',image:probe.image},
            ]}],80,fetcher);
            if(JSON.stringify(JSON.parse(answer.trim().replace(/^```(?:json)?\s*|\s*```$/g,'')))!==JSON.stringify(probe.expected)) throw new Error('Vision probe was not verified');
            if(verified.size>36) verified.clear();
            verified.set(fingerprint,Date.now()+600_000);
          }
          const text=await generate(slot,model,options.system,options.messages,options.maxOutputTokens??10000,fetcher);
          const parsed=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
          if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || typeof parsed.verdict!=='string') throw new Error('Invalid chart JSON');
          return {text,provider:slot.provider,model,slot:slot.slot};
        } catch {
          // Provider bodies may contain credentials or user charts: never log them.
          attempts.push({slot:slot.slot,reason:'Model unavailable, image capability unverified, or analysis incomplete.'});
        }
      }
    } catch { attempts.push({slot:slot.slot,reason:'Slot configuration, discovery, or network request failed.'}); }
  }
  throw new VisionSlotsError(attempts);
}
