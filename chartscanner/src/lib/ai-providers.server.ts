// Recovered provider entry point, narrowed for the personal Deriv runtime.
// The upstream provider module is retained under chartscanner/upstream/.
// This native adapter needs no Supabase, payment system, or Node packages.
import { runVisionSlots } from "./vision-slots.server.ts";
export { loadVisionSlots, VisionSlotsError } from "./vision-slots.server.ts";

export async function AnalyzeChart(options: {userId?: string; temperature?: number; system?: string; messages: any[]; maxOutputTokens?: number}) {
  return runVisionSlots(options);
}
