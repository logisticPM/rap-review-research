/**
 * PoC extension — ground the static reviewer + LLM∩tool corroboration against
 * Qodo GROUND TRUTH. Zero LLM. Tests the core claim: is an LLM finding that a
 * deterministic tool ALSO flags more precise than an LLM finding alone?
 *
 * All matching here is STRICT (file + line overlap) via the default IssueMatcher
 * — static findings were never sent to the semantic judge, so strict is the only
 * apples-to-apples matcher for both sources. Precision figures are therefore
 * strict-precision (lower than the semantic headline), used only for the
 * within-analysis LLM-vs-LLM∩tool comparison. Small N (a 5-rule prototype) →
 * directional, not powered.
 *
 * Env: BENCHMARK_DATA_DIR, PHASE2_OUT_DIR, RUNS_IN.
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import { BenchmarkLoader } from "../src/campaign/index.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { StaticAnalysisReviewer, crossSourceCorroborate } from "../src/architectures/static-analysis/index.ts";

const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? join(import.meta.dirname, "..", "data", "benchmark"));
const RUNS_IN = process.env.RUNS_IN ?? join(resolve(process.env.PHASE2_OUT_DIR ?? join(import.meta.dirname, "..", "phase2-results")), "qodo-all-runs.json");

const dataset = new BenchmarkLoader().loadQodo(JSON.parse(readFileSync(join(DATA_DIR, "qodo.json"), "utf8")));
const runs = JSON.parse(readFileSync(RUNS_IN, "utf8")) as BenchmarkRun[];
const strict = new IssueMatcher(); // file + line overlap, no semantic

const llmByInstance = new Map<string, ReviewFinding[]>();
for (const r of runs) {
  if (r.architecture !== "agentless") continue;
  llmByInstance.set(r.instanceId, [...(llmByInstance.get(r.instanceId) ?? []), ...r.producedFindings]);
}
const reviewer = new StaticAnalysisReviewer();
const isTP = (f: ReviewFinding, gt: GroundTruthIssue[]): boolean => gt.some((g) => strict.match(f, g).matched);

let staticN = 0, staticTP = 0;
let staticOnlyN = 0, staticOnlyTP = 0;
let llmN = 0, llmTP = 0;
let corrN = 0, corrTP = 0;
let gtTotal = 0;
const gtRules = new Set<string>();

for (const inst of dataset.instances) {
  const gt = inst.groundTruth;
  gtTotal += gt.length;
  for (const g of gt) if (g.category) gtRules.add(g.category.trim().toLowerCase());

  const staticFindings = reviewer.review(inst.rawDiff);
  const llm = llmByInstance.get(inst.instanceId) ?? [];
  const { corroborated, staticOnly } = crossSourceCorroborate(llm, staticFindings, 2);

  for (const s of staticFindings) { staticN += 1; if (isTP(s, gt)) staticTP += 1; }
  for (const s of staticOnly) { staticOnlyN += 1; if (isTP(s, gt)) staticOnlyTP += 1; }
  for (const l of llm) { llmN += 1; if (isTP(l, gt)) llmTP += 1; }
  for (const l of corroborated) { corrN += 1; if (isTP(l, gt)) corrTP += 1; }
}

const pct = (a: number, b: number): string => (b === 0 ? "–" : `${((a / b) * 100).toFixed(0)}% (${a}/${b})`);
console.log(`=== static-analysis grounded against Qodo GT (strict file+line) ===`);
console.log(`GT: ${gtTotal} issues across ${dataset.instances.length} PRs; ${gtRules.size} distinct rule categories`);
console.log(`\nstrict precision by source:`);
console.log(`  agentless LLM (pooled):           ${pct(llmTP, llmN)}`);
console.log(`  LLM ∩ tool (corroborated LLM):    ${pct(corrTP, corrN)}   ← the agreement subset`);
console.log(`  static-analysis findings (all):   ${pct(staticTP, staticN)}`);
console.log(`  static-ONLY (LLM missed the spot):${pct(staticOnlyTP, staticOnlyN)}   ← complementary coverage`);
console.log(`\nSignal: LLM∩tool precision ${corrN > 0 && llmN > 0 ? ((corrTP / corrN) > (llmTP / llmN) ? "HIGHER" : "not higher") : "n/a"} than LLM alone (small N — directional).`);
console.log(`Note: strict-only (static never semantically judged); a 5-rule prototype → coverage is tiny. Real analyzer on repo config would scale this.`);
