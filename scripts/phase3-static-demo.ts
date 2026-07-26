/**
 * PoC demo — run the Tier-1 StaticAnalysisReviewer over the real Qodo diffs and
 * cross-corroborate with the persisted agentless LLM findings. Zero LLM.
 * Illustrates: (1) a deterministic member finds real rule-violations on the
 * benchmark; (2) LLM∩tool agreement (precision signal) + tool-only coverage.
 *
 * Env: BENCHMARK_DATA_DIR (=<repo>/data/benchmark), PHASE2_OUT_DIR, RUNS_IN.
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import { BenchmarkLoader } from "../src/campaign/index.ts";
import { StaticAnalysisReviewer, crossSourceCorroborate } from "../src/architectures/static-analysis/index.ts";

const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? join(import.meta.dirname, "..", "data", "benchmark"));
const RUNS_IN = process.env.RUNS_IN ?? join(resolve(process.env.PHASE2_OUT_DIR ?? join(import.meta.dirname, "..", "phase2-results")), "qodo-all-runs.json");

const dataset = new BenchmarkLoader().loadQodo(JSON.parse(readFileSync(join(DATA_DIR, "qodo.json"), "utf8")));
const runs = JSON.parse(readFileSync(RUNS_IN, "utf8")) as BenchmarkRun[];

// pool agentless findings per instance (the LLM baseline candidate set)
const llmByInstance = new Map<string, ReviewFinding[]>();
for (const r of runs) {
  if (r.architecture !== "agentless") continue;
  llmByInstance.set(r.instanceId, [...(llmByInstance.get(r.instanceId) ?? []), ...r.producedFindings]);
}

const reviewer = new StaticAnalysisReviewer();
const byRule = new Map<string, number>();
let totalStatic = 0;
let prsWithStatic = 0;
let corroboratedLlm = 0;
let staticOnly = 0;
let llmTotal = 0;

for (const inst of dataset.instances) {
  const staticFindings = reviewer.review(inst.rawDiff);
  totalStatic += staticFindings.length;
  if (staticFindings.length > 0) prsWithStatic += 1;
  for (const s of staticFindings) {
    const rule = s.id.split(":")[1] ?? "?";
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }
  const llm = llmByInstance.get(inst.instanceId) ?? [];
  llmTotal += llm.length;
  const c = crossSourceCorroborate(llm, staticFindings, 2);
  corroboratedLlm += c.corroborated.length;
  staticOnly += c.staticOnly.length;
}

console.log(`=== StaticAnalysisReviewer over Qodo (${dataset.instances.length} PRs) ===`);
console.log(`static findings: ${totalStatic} across ${prsWithStatic} PR(s)`);
console.log(`by rule: ${[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join("  ") || "(none)"}`);
console.log(`\n=== cross-source corroboration vs pooled agentless LLM findings ===`);
console.log(`LLM findings (pooled agentless): ${llmTotal}`);
console.log(`LLM findings corroborated by a nearby static finding (LLM∩tool): ${corroboratedLlm}`);
console.log(`static findings with NO nearby LLM finding (tool-only coverage): ${staticOnly}`);
console.log(`\nPoC: a deterministic member adds an independent signal — LLM∩tool agreement (precision) + tool-only findings (complementary coverage the model missed).`);
