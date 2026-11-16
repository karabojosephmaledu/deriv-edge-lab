// Local process bridge for the existing Python app. No HTTP listener, database,
// provider login or broker-order API; stdout carries only the analysis JSON.
import { localScan } from "../src/lib/local-rules.server.ts";

let input="";
try {
  for await (const chunk of process.stdin) {
    input+=chunk;
    if(input.length>24_000_000) throw new Error("Input too large");
  }
  const payload=JSON.parse(input);
  if(typeof payload.symbol!=='string' || !payload.frames || typeof payload.frames!=='object')throw new Error('Invalid local input');
  const result=localScan(payload.symbol,payload.frames || {});
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch {
  process.stdout.write(JSON.stringify({ok:false,error_code:'local_rules_failed',attempts:[]}));
  process.exitCode=1;
}
