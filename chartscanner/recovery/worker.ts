// Local process bridge for the existing Python app. No HTTP listener, database,
// provider login or broker-order API; stdout carries only the analysis JSON.
import { runChartScan } from "../src/lib/scan-engine.server.ts";
import { AnalyzeChart } from "../src/lib/ai-providers.server.ts";

let input="";
try {
  for await (const chunk of process.stdin) {
    input+=chunk;
    if(input.length>24_000_000) throw new Error("Input too large");
  }
  const payload=JSON.parse(input);
  const result=await runChartScan({userId:"personal-chart-scanner",images:payload.images,
    priorAnalysis:payload.priorAnalysis ?? null, extraInstruction:payload.context ?? "",
    analyze:AnalyzeChart,
  });
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch {
  process.stdout.write(JSON.stringify({ok:false,error:"Chart analysis unavailable or unverified. Check server-side AI slots, Node runtime and readable market charts."}));
  process.exitCode=1;
}
