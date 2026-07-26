/**
 * phaseb-adapt-eval — doc 09 Phase B(i): format-porting dev loop.
 *
 * EXPLORATORY. Runs ONE (model, promptVersion) combination on a small dev set
 * of Qodo PRs that is DISJOINT from the 21-instance evaluation batch (so
 * Phase C stays untuned), and reports the iteration signals: completed runs,
 * zero-finding runs, findings/run, strict P/R/F1 vs golden.
 *
 * Protocol (adaptation-log.md records every iteration):
 *   - format-ONLY changes per family (FormatSpread discipline: semantic
 *     content identical to v1; only output-format scaffolding may differ);
 *   - equal budget per family: <=3 iterations x 5 dev PRs x RUNS runs;
 *   - after the last iteration the winning promptVersion is FROZEN and only
 *     then may Phase C generate on the evaluation batch.
 *
 * Run:  MODEL=deepseek.v3.2 PROMPT_VERSION=v1-deepseek npm run phaseb:dev
 * Env:  MODEL (required)              Bedrock model id
 *       PROMPT_VERSION (=v1)          template dir under prompts/templates/
 *       LABEL (=MODEL@PROMPT_VERSION) output file label
 *       RUNS (=2)                     runs per dev PR
 *       DEV_COUNT (=5)                dev-set size
 *       EVAL_RUNS (=data/experiments/2026-07-12-hetero-team/haiku-agentless-runs.json)
 *                                     source of eval-batch ids to EXCLUDE
 *       OUT_DIR (=data/experiments/2026-07-13-phaseb)
 *       BENCHMARK_DATA_DIR (=data/benchmark)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

import { createPRImportService } from "../src/services/snapshot/index.ts";
import { createExperimentService } from "../src/services/experiment/index.ts";
import { InMemorySnapshotRepository } from "../src/repositories/in-memory/in-memory-snapshot-repository.ts";
import { InMemoryRawDiffStorage } from "../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { InMemoryArchitectureRegistry } from "../src/architectures/in-memory-architecture-registry.ts";
import { AgentlessArchitecture } from "../src/architectures/agentless/agentless-architecture.ts";
import { PromptBuilder } from "../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../src/llm/prompts/context-builder.ts";
import { BedrockProvider } from "../src/llm/provider/bedrock-provider.ts";
import { LLM_CONFIG } from "../src/config/llm.ts";
import { BenchmarkLoader, CampaignRunner, InMemoryManifestStore, ProgressReporter, RetryPolicy } from "../src/campaign/index.ts";
import type { BenchmarkDataset } from "../src/benchmark/index.ts";
import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";

const MODEL = process.env.MODEL;
if (!MODEL) {
  console.error("Set MODEL to a Bedrock model id (e.g. deepseek.v3.2).");
  process.exit(1);
}
const PROMPT_VERSION = process.env.PROMPT_VERSION ?? "v1";
const LABEL = (process.env.LABEL ?? `${MODEL}@${PROMPT_VERSION}`).replace(/[^a-z0-9.@-]/gi, "_");
const RUNS = Math.max(1, Number(process.env.RUNS ?? 2));
const DEV_COUNT = Math.max(1, Number(process.env.DEV_COUNT ?? 5));
const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? "data/benchmark");
const OUT_DIR = resolve(process.env.OUT_DIR ?? "data/experiments/2026-07-13-phaseb");
const EVAL_RUNS = resolve(
  process.env.EVAL_RUNS ?? "data/experiments/2026-07-12-hetero-team/haiku-agentless-runs.json",
);

// Template must exist before we spend tokens on it.
const loader = new PromptLoader();
if (!loader.has(PROMPT_VERSION, "agentless", "system")) {
  console.error(`No template ${PROMPT_VERSION}/agentless/system.md — create it first.`);
  process.exit(1);
}

// --- dev set: first DEV_COUNT Qodo instances NOT in the evaluation batch -------
const evalIds = new Set(
  (JSON.parse(readFileSync(EVAL_RUNS, "utf8")) as BenchmarkRun[]).map((r) => r.instanceId),
);
function loadDevDataset(): BenchmarkDataset {
  const raw = JSON.parse(readFileSync(resolve(DATA_DIR, "qodo.json"), "utf8"));
  const full = new BenchmarkLoader().loadQodo(raw as never);
  const dev = full.instances.filter((i) => !evalIds.has(i.instanceId)).slice(0, DEV_COUNT);
  if (dev.length < DEV_COUNT) {
    console.error(`Only ${dev.length} non-eval instances available (< ${DEV_COUNT}).`);
    process.exit(1);
  }
  return { ...full, instances: dev };
}
const devDataset = loadDevDataset();
const devIds = devDataset.instances.map((i) => i.instanceId);
console.log(
  `phaseb-adapt-eval — ${MODEL} @ ${PROMPT_VERSION} (label ${LABEL})\n` +
    `dev set (disjoint from eval batch): ${devIds.join(", ")} × ${RUNS} runs`,
);

// --- generate (resumable per label) --------------------------------------------
async function generate(): Promise<BenchmarkRun[]> {
  const outFile = join(OUT_DIR, `phaseb-runs-${LABEL}.json`);
  if (existsSync(outFile)) {
    const cached = JSON.parse(readFileSync(outFile, "utf8")) as BenchmarkRun[];
    console.log(`loaded ${cached.length} runs from ${outFile} (skipping generation)`);
    return cached;
  }
  if (LLM_CONFIG.provider !== "bedrock") {
    console.error("phaseb:dev needs the Bedrock provider for real generation. Unset LLM_PROVIDER=mock.");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const provider = new BedrockProvider();
  const promptBuilder = new PromptBuilder({ loader, contextBuilder: new ContextBuilder() });
  const snapshots = new InMemorySnapshotRepository();
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const registry = new InMemoryArchitectureRegistry();
  registry.register(new AgentlessArchitecture({ provider, promptBuilder, rawDiffStorage }));
  const importCtx = createPRImportService({ snapshots, rawDiffStorage });
  const experimentCtx = createExperimentService({ snapshots, registry });
  const runner = new CampaignRunner({
    importService: importCtx.service,
    experimentService: experimentCtx.service,
    storage: experimentCtx.storage,
    reporter: new ProgressReporter({ sink: (line) => console.log(`  [${LABEL}] ${line}`) }),
    manifestStore: new InMemoryManifestStore(),
    retryPolicy: new RetryPolicy(6),
  });
  const report = await runner.run([devDataset], {
    campaignId: `phaseb-${LABEL}`,
    architectures: ["agentless"],
    runsPerInstance: RUNS,
    modelVersion: MODEL,
    promptVersion: PROMPT_VERSION,
    workflowVersion: "workflow-v1",
    evaluationVersion: "eval-v1",
    platformVersion: "v1.0.0",
    awsRegion: LLM_CONFIG.region,
    generatedAt: new Date().toISOString(),
  });
  const runs = report.outcomes.map((o) => o.benchmarkRun);
  writeFileSync(outFile, JSON.stringify(runs, null, 1));
  console.log(`persisted ${runs.length} runs → ${outFile}`);
  return runs;
}

// --- iteration signals -----------------------------------------------------------
async function main(): Promise<void> {
  const runs = await generate();
  const expected = devIds.length * RUNS;
  const zeroFinding = runs.filter((r) => r.producedFindings.length === 0).length;
  const strict = new GroundTruthEvaluator();
  const results = runs.map((r) => strict.evaluate(r));
  const n = results.length || 1;
  const p = results.reduce((a, x) => a + x.precision, 0) / n;
  const rec = results.reduce((a, x) => a + x.recall, 0) / n;
  const f1 = results.reduce((a, x) => a + x.f1, 0) / n;
  const avg = runs.reduce((a, r) => a + r.producedFindings.length, 0) / n;

  console.log(`\n=== iteration signals — ${LABEL} ===`);
  console.log(`completed runs:   ${runs.length}/${expected}${runs.length < expected ? "  ⚠ FAILED RUNS (parse/validation)" : ""}`);
  console.log(`zero-finding runs: ${zeroFinding}/${runs.length}`);
  console.log(`findings/run:      ${avg.toFixed(1)}`);
  console.log(`strict P/R/F1:     ${p.toFixed(2)} / ${rec.toFixed(2)} / ${f1.toFixed(2)}`);
  console.log(
    `\nRecord this row in ${join(OUT_DIR, "adaptation-log.md")} before the next iteration.\n` +
      `Gate check (semantic, vs Haiku) happens on Phase C data, not dev — dev is strict-only by design.`,
  );

  const reportPath = join(OUT_DIR, `phaseb-report-${LABEL}.json`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      { label: LABEL, model: MODEL, promptVersion: PROMPT_VERSION, devIds, runsPerInstance: RUNS,
        completed: runs.length, expected, zeroFinding, findingsPerRun: avg, strict: { p, r: rec, f1 } },
      null,
      2,
    ),
  );
  console.log(`report → ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
