/**
 * LIVE benchmark campaign against real Bedrock (Experiment Campaign Runner).
 *
 * Run with: `npm run campaign:live`
 *
 * Unlike `campaign:run` (MockProvider, sample fixtures), this executes real
 * Agentless/Generalists-3/Hierarchical/Consensus reviews through Bedrock on a
 * SMALL subset of real dataset PRs — so you can validate the pipeline
 * end-to-end before a full campaign. It:
 *   - uses the AWS SDK default credential provider chain (no keys in the repo),
 *   - reads real dataset files you provide (never downloads anything),
 *   - is NOT part of `npm run check` (it costs Bedrock inference and is
 *     non-deterministic).
 *
 * Preconditions (runbook 03 §3): `aws sso login` (or `aws configure`), Bedrock
 * model access enabled, correct region. Smoke-test first: `npm run smoke:bedrock`.
 *
 * Dataset files (raw JSON in the adapter shapes — see src/benchmark/README.md):
 *   $BENCHMARK_DATA_DIR/qodo.json   (Qodo PR-Review-Bench subset)
 *   $BENCHMARK_DATA_DIR/swe.json    (SWE-PRBench subset)
 * Defaults: BENCHMARK_DATA_DIR=./data/benchmark, BENCHMARK_LIMIT=1 (per dataset).
 */
import { existsSync, readFileSync } from "node:fs";
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

import { BenchmarkLoader } from "../src/campaign/index.ts";
import type { BenchmarkDataset } from "../src/benchmark/index.ts";
import { CampaignRunner, InMemoryManifestStore, ProgressReporter } from "../src/campaign/index.ts";

const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? "data/benchmark");
const LIMIT = Math.max(1, Number(process.env.BENCHMARK_LIMIT ?? 1));

const loader = new BenchmarkLoader();
const datasets: BenchmarkDataset[] = [];

const qodoPath = resolve(DATA_DIR, "qodo.json");
if (existsSync(qodoPath)) {
  datasets.push(subset(loader.loadQodo(JSON.parse(readFileSync(qodoPath, "utf8"))), LIMIT));
}
const swePath = resolve(DATA_DIR, "swe.json");
if (existsSync(swePath)) {
  datasets.push(subset(loader.loadSwe(JSON.parse(readFileSync(swePath, "utf8"))), LIMIT));
}

if (datasets.length === 0) {
  console.error(
    [
      "No dataset files found. Provide real dataset rows (in the adapter shapes) at:",
      `  ${qodoPath}`,
      `  ${swePath}`,
      "or set BENCHMARK_DATA_DIR. See src/benchmark/README.md for the expected fields.",
    ].join("\n"),
  );
  process.exit(1);
}

// Real Bedrock provider (default AWS credential chain) shared by all arms —
// they differ only in how the same underlying model spends compute (agentless:
// 1 call; generalists-3: N parallel samples merged; hierarchical/consensus:
// multiple roles/rounds), not in the model itself (fairness policy).
const provider = new BedrockProvider();
const promptBuilder = new PromptBuilder({
  loader: new PromptLoader(),
  contextBuilder: new ContextBuilder(),
});
const snapshots = new InMemorySnapshotRepository();
const rawDiffStorage = new InMemoryRawDiffStorage();

const registry = new InMemoryArchitectureRegistry();
registry.register(new AgentlessArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createHierarchicalArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createConsensusArchitecture({ provider, promptBuilder, rawDiffStorage }));

const importCtx = createPRImportService({ snapshots, rawDiffStorage });
const experimentCtx = createExperimentService({ snapshots, registry });

const reporter = new ProgressReporter({ sink: (line) => console.log(line) });
const runner = new CampaignRunner({
  importService: importCtx.service,
  experimentService: experimentCtx.service,
  storage: experimentCtx.storage,
  reporter,
  manifestStore: new InMemoryManifestStore(),
});

console.log(`LIVE campaign — Bedrock model ${LLM_CONFIG.defaultModel} @ ${LLM_CONFIG.region}`);
console.log(`  datasets: ${datasets.map((d) => `${d.source}(${d.instances.length})`).join(", ")}\n`);

const report = await runner.run(datasets, {
  campaignId: "campaign-live",
  // The full test-time-compute ladder (one variable per rung). Passed
  // explicitly because `generalists-3` is intentionally NOT in the global
  // BENCHMARK_ARCHITECTURES default (opt-in); the runner would otherwise skip
  // it even though it is registered above.
  architectures: ["agentless", "generalists-3", "hierarchical", "consensus"],
  modelVersion: LLM_CONFIG.defaultModel,
  promptVersion: "v1",
  workflowVersion: "workflow-v1",
  evaluationVersion: "eval-v1",
  platformVersion: "v1.0.0",
  awsRegion: LLM_CONFIG.region,
  generatedAt: new Date().toISOString(),
});

console.log("\n=== progress ===");
console.log(JSON.stringify(report.summary.progress, null, 2));
console.log("\n=== per-architecture summary ===");
for (const s of report.summary.perArchitecture) {
  console.log(
    `${s.architecture.padEnd(13)} n=${s.instanceCount} ` +
      `meanP=${s.meanPrecision.toFixed(2)} meanR=${s.meanRecall.toFixed(2)} meanF1=${s.meanF1.toFixed(2)}`,
  );
}
if (report.summary.failures.length > 0) {
  console.log("\n=== failures ===");
  for (const f of report.summary.failures) {
    console.log(`${f.instanceId} ${f.architecture} (x${f.attempts}): ${f.error}`);
  }
}
console.log("\n=== benchmark CSV ===");
console.log(report.exports.benchmarkCsv);

function subset(dataset: BenchmarkDataset, limit: number): BenchmarkDataset {
  return { ...dataset, instances: dataset.instances.slice(0, limit) };
}
