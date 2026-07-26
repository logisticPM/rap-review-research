/**
 * A2 re-evaluation — strict (file+line) vs semantic (LLM-judge) matching.
 *
 * Run with: `npm run judge:eval`
 *
 * The strict file+line matcher counts a produced finding as a true positive only
 * when it lands on (near) the ground-truth line. That understates the
 * multi-agent arms, which phrase/relocate the same issue. This script applies
 * A2 (Approach A): generate the ladder live, run a **non-Anthropic Bedrock
 * judge** (Llama, a different family than the Claude systems under test) over
 * the candidate pairs into a persisted `SemanticScoreCache`, then evaluate the
 * SAME runs twice — strict and semantic (`score >= τ`) — and print the delta.
 *
 * Replayable: the judge cache and the raw runs are written to disk, so τ can be
 * retuned with `CACHE_IN=... RUNS_IN=...` at zero generation/judge cost.
 *
 * Env:
 *   BENCHMARK_DATA_DIR (=data/benchmark), BENCHMARK_LIMIT (=1 per dataset)
 *   LLM_DEFAULT_MODEL / LLM_REGION  — the systems under test (see config/llm.ts)
 *   JUDGE_MODEL (=DEFAULT_JUDGE_CONFIG.modelId) — the non-Anthropic judge
 *   SEMANTIC_THRESHOLD (=0.7) — τ, the semantic rescue cutoff
 *   CAMPAIGN_CONCURRENCY (=1) — opt-in generation concurrency; 1 = sequential
 *     (byte-identical to before). >1 runs that many (instance × arch × run)
 *     entries at once; the judge pass below stays sequential.
 *   RUNS_RESUME_IN — instance-level resume: carry already-complete instances
 *     from this file and regenerate only incomplete ones (daily-cap budget
 *     saver). Distinct from RUNS_IN (all-or-nothing replay).
 *   RUNS_IN / RUNS_OUT, CACHE_IN / CACHE_OUT — replay artifacts (JSON)
 *   Smoke-test Bedrock first: `npm run smoke:bedrock`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { CampaignRunner, InMemoryManifestStore, ProgressReporter, RetryPolicy } from "../src/campaign/index.ts";
import type { BenchmarkDataset } from "../src/benchmark/index.ts";
import { planInstanceResume } from "../src/benchmark/index.ts";
import type { ReviewArchitecture } from "../src/models/experiment.ts";
import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { BenchmarkResult } from "../src/benchmark/models/benchmark-result.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";
import { JudgeScorePrecomputer } from "../src/benchmark/matching/judge-score-precomputer.ts";
import { DEFAULT_JUDGE_CONFIG } from "../src/benchmark/matching/judge-prompt.ts";
import { ProviderRateLimitError } from "../src/llm/errors.ts";

if (LLM_CONFIG.provider !== "bedrock") {
  console.error("judge:eval needs the Bedrock provider (live). Unset LLM_PROVIDER=mock.");
  process.exit(1);
}

const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? "data/benchmark");
const LIMIT = Math.max(1, Number(process.env.BENCHMARK_LIMIT ?? 1));
// Chunked/resumable runs: process instances [OFFSET, OFFSET+LIMIT) so a long
// campaign can be split into token-sized chunks (shared CACHE accumulates).
const OFFSET = Math.max(0, Number(process.env.BENCHMARK_OFFSET ?? 0));
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_CONFIG.modelId;
// Opt-in bounded concurrency for the generation phase (the SUT ladder — the
// dominant cost). Default 1 = sequential, byte-identical to before. Verified
// content-equivalent to sequential in
// tests/unit/campaign-concurrency-consistency.test.ts. Only the CampaignRunner
// generation is parallelized; the judge precompute below is unchanged.
const CONCURRENCY = Math.max(1, Number(process.env.CAMPAIGN_CONCURRENCY ?? 1));
const RUNS_PER_INSTANCE = Math.max(1, Number(process.env.RUNS_PER_INSTANCE ?? 1));
// Instance-level resume: when set (the driver points it at the chunk's own runs
// file), already-complete instances are carried verbatim and only incomplete
// ones are regenerated — the daily-cap budget saver. Distinct from RUNS_IN,
// which is all-or-nothing replay and is left untouched.
const RESUME_IN = process.env.RUNS_RESUME_IN;
const CAMPAIGN_ARCHITECTURES: ReviewArchitecture[] = [
  "agentless",
  "generalists-3",
  "hierarchical",
  "consensus",
];

const provider = new BedrockProvider();

// --- 1. Runs: load persisted (replay) or generate the ladder live ------------
let runs: BenchmarkRun[];
if (process.env.RUNS_IN && existsSync(process.env.RUNS_IN)) {
  runs = JSON.parse(readFileSync(process.env.RUNS_IN, "utf8")) as BenchmarkRun[];
  console.log(`loaded ${runs.length} runs from ${process.env.RUNS_IN} (skipping generation)`);
} else {
  const loader = new BenchmarkLoader();
  const datasets: BenchmarkDataset[] = [];
  const qodoPath = resolve(DATA_DIR, "qodo.json");
  if (existsSync(qodoPath)) {
    datasets.push(subset(loader.loadQodo(JSON.parse(readFileSync(qodoPath, "utf8"))), LIMIT, OFFSET));
  }
  const swePath = resolve(DATA_DIR, "swe.json");
  if (existsSync(swePath)) {
    datasets.push(subset(loader.loadSwe(JSON.parse(readFileSync(swePath, "utf8"))), LIMIT, OFFSET));
  }
  if (datasets.length === 0) {
    console.error(`No datasets under ${DATA_DIR}. See src/benchmark/README.md.`);
    process.exit(1);
  }

  // Instance-level resume (RUNS_RESUME_IN): carry already-complete instances and
  // regenerate only incomplete ones. Byte-neutral to the frozen generation
  // config — see src/benchmark/resume-plan.ts.
  const expectedPerInstance = CAMPAIGN_ARCHITECTURES.length * RUNS_PER_INSTANCE;
  const intendedInstanceIds = datasets.flatMap((d) => d.instances.map((i) => i.instanceId));
  let carriedRuns: BenchmarkRun[] = [];
  let effectiveDatasets = datasets;
  if (RESUME_IN && existsSync(RESUME_IN)) {
    const priorRuns = JSON.parse(readFileSync(RESUME_IN, "utf8")) as BenchmarkRun[];
    const plan = planInstanceResume(priorRuns, intendedInstanceIds, expectedPerInstance);
    carriedRuns = plan.carriedRuns;
    const toRun = new Set(plan.instanceIdsToRun);
    effectiveDatasets = datasets.map((d) => ({
      ...d,
      instances: d.instances.filter((i) => toRun.has(i.instanceId)),
    }));
    console.log(
      `RESUME — ${plan.completeInstanceIds.length}/${intendedInstanceIds.length} instance(s) complete ` +
        `(${carriedRuns.length} runs carried); regenerating ${plan.instanceIdsToRun.length}`,
    );
  }
  const instancesToRun = effectiveDatasets.reduce((n, d) => n + d.instances.length, 0);

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
    importService: importCtx.service,
    experimentService: experimentCtx.service,
    storage: experimentCtx.storage,
    reporter: new ProgressReporter({ sink: (line) => console.log(line) }),
    manifestStore: new InMemoryManifestStore(),
    // More attempts + exponential backoff to ride out Bedrock throttling on a
    // long campaign (default 3 was too few under sustained load).
    retryPolicy: new RetryPolicy(6),
  });

  let newRuns: BenchmarkRun[] = [];
  if (instancesToRun > 0) {
    console.log(`GENERATE — model ${LLM_CONFIG.defaultModel} @ ${LLM_CONFIG.region} · concurrency=${CONCURRENCY}\n`);
    const report = await runner.run(effectiveDatasets, {
      campaignId: "judge-eval",
      architectures: CAMPAIGN_ARCHITECTURES,
      maxConcurrency: CONCURRENCY,
      // Registered protocol (pre-reg §3.3, freeze manifest): 3 runs/instance for
      // the confirmatory campaign. Default 1 for cheap pilots; set RUNS_PER_INSTANCE=3.
      runsPerInstance: RUNS_PER_INSTANCE,
      modelVersion: LLM_CONFIG.defaultModel,
      promptVersion: "v1",
      workflowVersion: "workflow-v1",
      evaluationVersion: "eval-v1",
      platformVersion: "v1.0.0",
      awsRegion: LLM_CONFIG.region,
      generatedAt: new Date().toISOString(),
    });
    newRuns = report.outcomes.map((o) => o.benchmarkRun);
  } else {
    console.log(`RESUME — all ${intendedInstanceIds.length} instance(s) already complete; skipping generation`);
  }
  runs = [...carriedRuns, ...newRuns];
  if (process.env.RUNS_OUT) {
    writeFileSync(process.env.RUNS_OUT, JSON.stringify(runs, null, 2));
    console.log(`persisted ${runs.length} runs → ${process.env.RUNS_OUT}`);
  }

  // Authoritative completion signal for phase2-driver: the chunk is done iff
  // every intended instance now has its full run set (carried + freshly run).
  const finalCount = new Map<string, number>();
  for (const r of runs) finalCount.set(r.instanceId, (finalCount.get(r.instanceId) ?? 0) + 1);
  const completeCount = intendedInstanceIds.filter(
    (id) => (finalCount.get(id) ?? 0) >= expectedPerInstance,
  ).length;
  const complete = completeCount === intendedInstanceIds.length;
  console.log(
    `phase2-generation complete=${complete} generated=${newRuns.length} carried=${carriedRuns.length} ` +
      `total=${runs.length} expected=${intendedInstanceIds.length * expectedPerInstance}`,
  );
}

// --- 2. Judge: fill the semantic score cache (or load a persisted one) --------
let cache: SemanticScoreCache;
if (process.env.CACHE_IN && existsSync(process.env.CACHE_IN)) {
  cache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(process.env.CACHE_IN, "utf8")));
  console.log(`loaded judge cache from ${process.env.CACHE_IN} (skipping judge calls)`);
} else {
  cache = new SemanticScoreCache();
  console.log(`\nJUDGE — ${JUDGE_MODEL} over candidate pairs (same file, no line overlap)...`);
  const precomputer = new JudgeScorePrecomputer(provider, { ...DEFAULT_JUDGE_CONFIG, modelId: JUDGE_MODEL });
  // Bedrock throttles bursts; the precomputer is resumable (skips cached pairs),
  // so on a rate limit we checkpoint the cache, back off, and resume. Needed for
  // large runs (the full campaign would otherwise die mid-judge).
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await precomputer.precompute(runs, cache);
      break;
    } catch (error) {
      if (error instanceof ProviderRateLimitError && attempt < maxAttempts) {
        const waitMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
        if (process.env.CACHE_OUT) {
          writeFileSync(process.env.CACHE_OUT, JSON.stringify(cache.toJSON(), null, 2));
        }
        console.log(`  rate limited (attempt ${attempt}/${maxAttempts}); backing off ${waitMs}ms and resuming...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw error;
    }
  }
  if (process.env.CACHE_OUT) {
    writeFileSync(process.env.CACHE_OUT, JSON.stringify(cache.toJSON(), null, 2));
    console.log(`persisted judge cache → ${process.env.CACHE_OUT}`);
  }
}
const cacheSize = Object.keys(cache.toJSON()).length;

// --- 3. Evaluate twice: strict vs semantic (score >= τ) -----------------------
const strict = new GroundTruthEvaluator();
const semantic = new GroundTruthEvaluator({
  matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: TAU }),
});
const strictResults = runs.map((r) => strict.evaluate(r));
const semanticResults = runs.map((r) => semantic.evaluate(r));

// --- 4. Per-architecture macro means, strict vs semantic ----------------------
console.log(`\n=== strict (file+line) vs semantic (judge τ=${TAU}) — judge pairs scored: ${cacheSize} ===`);
console.log("arch".padEnd(14) + "  n   P(s)→P(sem)   R(s)→R(sem)   F1(s)→F1(sem)");
for (const arch of ["agentless", "generalists-3", "hierarchical", "consensus"]) {
  const idx = runs.map((r, i) => (r.architecture === arch ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) continue;
  const s = macro(idx.map((i) => strictResults[i]));
  const m = macro(idx.map((i) => semanticResults[i]));
  console.log(
    arch.padEnd(14) +
      `  ${idx.length}   ` +
      `${s.p.toFixed(2)}→${m.p.toFixed(2)}     ` +
      `${s.r.toFixed(2)}→${m.r.toFixed(2)}     ` +
      `${s.f1.toFixed(2)}→${m.f1.toFixed(2)}`,
  );
}

function macro(results: BenchmarkResult[]): { p: number; r: number; f1: number } {
  const n = results.length || 1;
  return {
    p: results.reduce((a, x) => a + x.precision, 0) / n,
    r: results.reduce((a, x) => a + x.recall, 0) / n,
    f1: results.reduce((a, x) => a + x.f1, 0) / n,
  };
}

function subset(dataset: BenchmarkDataset, limit: number, offset = 0): BenchmarkDataset {
  return { ...dataset, instances: dataset.instances.slice(offset, offset + limit) };
}
