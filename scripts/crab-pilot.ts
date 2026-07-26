/**
 * c-CRAB LIGHT-PATH PILOT (follow-up scoping) — prove end-to-end + validate
 * line-frame alignment on a few c-CRAB PRs using OUR frozen 4-arm ladder.
 * Reuses the exact benchmark-judge-eval generation setup. Strict eval only
 * (no semantic judge cache yet); the point is the line-frame diagnostic.
 *
 * Env: CRAB_JSONL (=data/benchmark/crab-stage4.jsonl), CRAB_N (=5),
 *      CRAB_MAX_DIFF_KB (=50), LLM_DEFAULT_MODEL/LLM_REGION, AWS_PROFILE=bedrock.
 *      Smoke Bedrock first: npm run smoke:bedrock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPRImportService } from "../src/services/snapshot/index.ts";
import { createExperimentService } from "../src/services/experiment/index.ts";
import { InMemorySnapshotRepository } from "../src/repositories/in-memory/in-memory-snapshot-repository.ts";
import { InMemoryRawDiffStorage } from "../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { InMemoryArchitectureRegistry } from "../src/architectures/in-memory-architecture-registry.ts";
import { AgentlessArchitecture } from "../src/architectures/agentless/agentless-architecture.ts";
import { createGeneralistsArchitecture } from "../src/architectures/generalists/index.ts";
import { createHierarchicalArchitecture } from "../src/architectures/hierarchical/index.ts";
import { createConsensusArchitecture } from "../src/architectures/consensus/index.ts";
import { PromptBuilder } from "../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../src/llm/prompts/context-builder.ts";
import { BedrockProvider } from "../src/llm/provider/bedrock-provider.ts";
import { LLM_CONFIG } from "../src/config/llm.ts";
import { CampaignRunner, InMemoryManifestStore, ProgressReporter, RetryPolicy } from "../src/campaign/index.ts";
import type { BenchmarkDataset } from "../src/benchmark/index.ts";
import type { BenchmarkInstance } from "../src/benchmark/models/benchmark-instance.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";

if (LLM_CONFIG.provider !== "bedrock") { console.error("crab-pilot needs Bedrock."); process.exit(1); }

const CRAB_JSONL = resolve(process.env.CRAB_JSONL ?? "data/benchmark/crab-stage4.jsonl");
const N = Math.max(1, Number(process.env.CRAB_N ?? 5));
const MAX_DIFF = Math.max(1, Number(process.env.CRAB_MAX_DIFF_KB ?? 50)) * 1024;

const resolveLine = (c: { line?: number | null; original_line?: number | null; start_line?: number | null; original_start_line?: number | null; diff_hunk?: string }): number | undefined => {
  for (const v of [c.line, c.original_line, c.start_line, c.original_start_line]) if (typeof v === "number") return v;
  const m = c.diff_hunk?.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
  return m ? Number(m[1]) : undefined;
};

const rows = readFileSync(CRAB_JSONL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
const instances: BenchmarkInstance[] = [];
for (const r of rows) {
  const diff: string | undefined = r.commit_to_review?.patch_to_review;
  if (typeof diff !== "string" || diff.length > MAX_DIFF) continue;
  const gt: GroundTruthIssue[] = [];
  (r.reference_review_comments ?? []).forEach((c: any, i: number) => {
    const line = resolveLine(c);
    if (c.path && line !== undefined) gt.push({ id: `${r.instance_id}-rc-${i}`, file: c.path, lineStart: line, lineEnd: line, title: (c.text ?? "").slice(0, 80), description: c.text ?? "" });
  });
  if (gt.length === 0) continue;
  instances.push({ instanceId: r.instance_id, title: r.title ?? r.instance_id, source: "swe-prbench", rawDiff: diff, groundTruth: gt }); // source = label shortcut for pilot
  if (instances.length >= N) break;
}
console.log(`c-CRAB pilot — ${instances.length} instances (≤${MAX_DIFF / 1024}KB diff); model ${LLM_CONFIG.defaultModel} @ ${LLM_CONFIG.region}\n`);
const dataset: BenchmarkDataset = { datasetId: "crab-pilot", name: "c-CRAB pilot", source: "swe-prbench", instances };

const provider = new BedrockProvider();
const promptBuilder = new PromptBuilder({ loader: new PromptLoader(), contextBuilder: new ContextBuilder() });
const snapshots = new InMemorySnapshotRepository();
const rawDiffStorage = new InMemoryRawDiffStorage();
const registry = new InMemoryArchitectureRegistry();
registry.register(new AgentlessArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createHierarchicalArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createConsensusArchitecture({ provider, promptBuilder, rawDiffStorage }));
const importCtx = createPRImportService({ snapshots, rawDiffStorage });
const experimentCtx = createExperimentService({ snapshots, registry });
const runner = new CampaignRunner({
  importService: importCtx.service, experimentService: experimentCtx.service, storage: experimentCtx.storage,
  reporter: new ProgressReporter({ sink: (line) => console.log(line) }), manifestStore: new InMemoryManifestStore(), retryPolicy: new RetryPolicy(6),
});

const report = await runner.run([dataset], {
  campaignId: "crab-pilot", architectures: ["agentless", "generalists-3", "hierarchical", "consensus"],
  maxConcurrency: 1, runsPerInstance: 1, modelVersion: LLM_CONFIG.defaultModel, promptVersion: "v1",
  workflowVersion: "workflow-v1", evaluationVersion: "eval-v1", platformVersion: "v1.0.0", awsRegion: LLM_CONFIG.region, generatedAt: new Date().toISOString(),
});
const runs: BenchmarkRun[] = report.outcomes.map((o) => o.benchmarkRun);

// --- strict eval + line-frame diagnostic --------------------------------------
const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
const strict = new GroundTruthEvaluator();
console.log(`\n=== strict eval + line-frame diagnostic (${runs.length} runs) ===`);
console.log("arch".padEnd(14) + " findings  fileHit  exact(strict)  near≤10  far/other");
for (const arch of ["agentless", "generalists-3", "hierarchical", "consensus"]) {
  const rs = runs.filter((r) => r.architecture === arch);
  let f = 0, fileHit = 0, exact = 0, near = 0, far = 0;
  for (const r of rs) {
    for (const finding of r.producedFindings) {
      f += 1;
      const sameFile = r.groundTruth.filter((g) => normPath(g.file) === normPath(finding.file));
      if (sameFile.length === 0) { far += 1; continue; }
      fileHit += 1;
      const d = Math.min(...sameFile.map((g) => finding.line < g.lineStart ? g.lineStart - finding.line : finding.line > g.lineEnd ? finding.line - g.lineEnd : 0));
      if (d === 0) exact += 1; else if (d <= 10) near += 1; else far += 1;
    }
  }
  console.log(arch.padEnd(14) + `${String(f).padStart(8)}  ${String(fileHit).padStart(7)}  ${String(exact).padStart(13)}  ${String(near).padStart(7)}  ${String(far).padStart(9)}`);
}
const macroP = (arch: string): string => { const rs = runs.filter((r) => r.architecture === arch).map((r) => strict.evaluate(r)); const n = rs.length || 1; return `P${(rs.reduce((a, x) => a + x.precision, 0) / n).toFixed(2)} R${(rs.reduce((a, x) => a + x.recall, 0) / n).toFixed(2)} F1${(rs.reduce((a, x) => a + x.f1, 0) / n).toFixed(2)}`; };
console.log(`\nstrict macro: ` + ["agentless", "generalists-3", "hierarchical", "consensus"].map((a) => `${a} ${macroP(a)}`).join(" | "));
console.log(`\nDiagnostic reading: high fileHit but exact≈0 & near>0 ⇒ LINE-FRAME OFFSET (arm reports new-file lines, GT uses original_line) → semantic matcher needed / frame reconcile. exact>0 ⇒ frames align.`);
