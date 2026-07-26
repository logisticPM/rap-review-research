/**
 * hetero-team-eval — does a HETEROGENEOUS model team beat a homogeneous one?
 * (doc 08 follow-up: "cross-model corroboration > within-model corroboration")
 *
 * EXPLORATORY, not part of the registered confirmatory analysis.
 *
 * Design: the same frozen agentless prompt is run as a "team of 3" two ways —
 *   homo    3 runs of ONE model (Haiku = the existing validation runs; DeepSeek
 *           and Llama teams generated here) → V1 = recurrence across runs
 *   hetero  1 run each of Haiku + DeepSeek + Llama → V1 = recurrence across MODELS
 * Same member count (3), same prompt, same instances — only team composition
 * varies. Single-model means are reported to expose the "stronger member"
 * confound. Generation uses DeepSeek/Llama quotas only (zero Haiku spend).
 *
 * Run:  RUNS_IN=<phase2-val-runs.json> CACHE_IN=<phase2-val-cache.json> \
 *       OUT_DIR=<dir> npm run hetero:eval          (resumable per phase/file)
 * Env:  HETERO_MODELS (default "deepseek.v3.2,us.meta.llama3-3-70b-instruct-v1:0"),
 *       SEMANTIC_THRESHOLD (=0.7), BENCHMARK_DATA_DIR (=data/benchmark)
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
import type { BenchmarkResult } from "../src/benchmark/models/benchmark-result.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";
import { JudgeScorePrecomputer } from "../src/benchmark/matching/judge-score-precomputer.ts";
import { DEFAULT_JUDGE_CONFIG } from "../src/benchmark/matching/judge-prompt.ts";
import { ProviderRateLimitError, ProviderTimeoutError } from "../src/llm/errors.ts";
import { areDuplicateFindings, dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";

if (LLM_CONFIG.provider !== "bedrock") {
  console.error("hetero:eval needs the Bedrock provider (live generation). Unset LLM_PROVIDER=mock.");
  process.exit(1);
}

const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? "data/benchmark");
const OUT_DIR = process.env.OUT_DIR ?? "hetero-out";
const HETERO_MODELS = (process.env.HETERO_MODELS ?? "deepseek.v3.2,us.meta.llama3-3-70b-instruct-v1:0")
  .split(",").map((s) => s.trim()).filter(Boolean);
const HAIKU_LABEL = "haiku-4.5 (frozen)";

const runsIn = process.env.RUNS_IN;
const cacheIn = process.env.CACHE_IN;
if (!runsIn || !existsSync(runsIn) || !cacheIn || !existsSync(cacheIn)) {
  console.error("Set RUNS_IN (validation runs) and CACHE_IN (judge cache).");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// --- existing Haiku agentless runs (the homogeneous baseline team) ------------
const valRuns = JSON.parse(readFileSync(runsIn, "utf8")) as BenchmarkRun[];
const haikuByInstance = new Map<string, BenchmarkRun[]>();
for (const r of valRuns.filter((x) => x.architecture === "agentless")) {
  haikuByInstance.set(r.instanceId, [...(haikuByInstance.get(r.instanceId) ?? []), r]);
}
const INSTANCE_IDS = [...haikuByInstance.keys()];
console.log(`hetero-team-eval — ${INSTANCE_IDS.length} instances; new-team models: ${HETERO_MODELS.join(", ")}`);

// --- phase 1: generate 3 agentless runs per new model (resumable per file) ----
function loadInstances(): BenchmarkDataset[] {
  const loader = new BenchmarkLoader();
  const datasets: BenchmarkDataset[] = [];
  for (const [file, load] of [
    ["qodo.json", (raw: unknown) => loader.loadQodo(raw as never)],
    ["swe.json", (raw: unknown) => loader.loadSwe(raw as never)],
  ] as const) {
    const p = resolve(DATA_DIR, file);
    if (!existsSync(p)) continue;
    const d = load(JSON.parse(readFileSync(p, "utf8")));
    const wanted = d.instances.filter((i) => INSTANCE_IDS.includes(i.instanceId));
    if (wanted.length > 0) datasets.push({ ...d, instances: wanted });
  }
  return datasets;
}

async function generateTeam(model: string): Promise<BenchmarkRun[]> {
  const safe = model.replace(/[^a-z0-9.-]/gi, "_");
  const outFile = join(OUT_DIR, `hetero-runs-${safe}.json`);
  if (existsSync(outFile)) {
    const cached = JSON.parse(readFileSync(outFile, "utf8")) as BenchmarkRun[];
    console.log(`loaded ${cached.length} ${model} runs from ${outFile} (skipping generation)`);
    return cached;
  }
  const provider = new BedrockProvider();
  const promptBuilder = new PromptBuilder({ loader: new PromptLoader(), contextBuilder: new ContextBuilder() });
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
    reporter: new ProgressReporter({ sink: (line) => console.log(`  [${model}] ${line}`) }),
    manifestStore: new InMemoryManifestStore(),
    retryPolicy: new RetryPolicy(6),
  });
  console.log(`\nGENERATE — agentless × 3 on ${model}`);
  const report = await runner.run(loadInstances(), {
    campaignId: `hetero-${safe}`,
    architectures: ["agentless"],
    runsPerInstance: 3,
    modelVersion: model,
    promptVersion: "v1",
    workflowVersion: "workflow-v1",
    evaluationVersion: "eval-v1",
    platformVersion: "v1.0.0",
    awsRegion: LLM_CONFIG.region,
    generatedAt: new Date().toISOString(),
  });
  const runs = report.outcomes.map((o) => o.benchmarkRun);
  writeFileSync(outFile, JSON.stringify(runs, null, 2));
  console.log(`persisted ${runs.length} runs → ${outFile}`);
  return runs;
}

// --- pooling: cluster findings across team members (A4 dedup semantics) -------
type Finding = BenchmarkRun["producedFindings"][number];
interface Cluster { readonly rep: Finding; readonly members: Set<number>; }

function clusterTeam(teamRuns: BenchmarkRun[]): Cluster[] {
  const clusters: Cluster[] = [];
  teamRuns.forEach((run, idx) => {
    for (const f of dedupeFindings(run.producedFindings)) {
      const hit = clusters.find((c) => areDuplicateFindings(c.rep, f));
      if (hit) hit.members.add(idx);
      else clusters.push({ rep: f, members: new Set([idx]) });
    }
  });
  return clusters;
}

function teamRows(label: string, teams: Map<string, BenchmarkRun[]>): { label: string; runs: BenchmarkRun[] }[] {
  const build = (suffix: string, min: number): { label: string; runs: BenchmarkRun[] } => ({
    label: `  ${label} ${suffix}`,
    runs: [...teams.entries()].map(([instanceId, teamRuns]) => ({
      ...teamRuns[0]!,
      runId: `${instanceId}#${label}#${suffix}`,
      producedFindings: clusterTeam(teamRuns).filter((c) => c.members.size >= min).map((c) => c.rep),
    })),
  });
  return [build("V0", 1), build("V1 k=2", 2), build("V1 k=3", 3)];
}

// --- main ---------------------------------------------------------------------
async function main(): Promise<void> {
  const newTeams = new Map<string, BenchmarkRun[]>(); // model -> runs
  for (const model of HETERO_MODELS) newTeams.set(model, await generateTeam(model));

  // Extend the judge cache with pairs for the NEW findings (resumable; Llama judge
  // per the registered eval config).
  const heteroCache = join(OUT_DIR, "hetero-cache.json");
  const baseJson = JSON.parse(readFileSync(cacheIn, "utf8")) as Record<string, number>;
  const extraJson = existsSync(heteroCache)
    ? (JSON.parse(readFileSync(heteroCache, "utf8")) as Record<string, number>)
    : {};
  // Merge at the JSON level (same key space); resumed runs skip already-judged pairs.
  const cache = SemanticScoreCache.fromJSON({ ...baseJson, ...extraJson });
  const provider = new BedrockProvider();
  const precomputer = new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG);
  const newRuns = [...newTeams.values()].flat();
  console.log(`\nJUDGE — ${DEFAULT_JUDGE_CONFIG.modelId} over new candidate pairs (${newRuns.length} runs)...`);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await precomputer.precompute(newRuns, cache);
      break;
    } catch (error) {
      const transient = error instanceof ProviderRateLimitError || error instanceof ProviderTimeoutError;
      writeFileSync(heteroCache, JSON.stringify(cache.toJSON(), null, 1));
      if (!transient || attempt === 8) throw error;
      const waitMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      console.log(`  judge throttled (attempt ${attempt}/8); backing off ${waitMs}ms...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  writeFileSync(heteroCache, JSON.stringify(cache.toJSON(), null, 1));

  const strict = new GroundTruthEvaluator();
  const semantic = new GroundTruthEvaluator({
    matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: TAU }),
  });
  const macro = (rs: BenchmarkResult[]): { p: number; r: number; f1: number } => {
    const n = rs.length || 1;
    return {
      p: rs.reduce((a, x) => a + x.precision, 0) / n,
      r: rs.reduce((a, x) => a + x.recall, 0) / n,
      f1: rs.reduce((a, x) => a + x.f1, 0) / n,
    };
  };

  // Teams: homo per model (3 runs each) + hetero (run #1 of each family).
  const rowSpecs: { label: string; runs: BenchmarkRun[] }[] = [];
  const singles: [string, BenchmarkRun[]][] = [
    [HAIKU_LABEL, [...haikuByInstance.values()].flat()],
    ...[...newTeams.entries()].map(([m, rs]): [string, BenchmarkRun[]] => [m, rs]),
  ];
  for (const [label, rs] of singles) rowSpecs.push({ label: `${label} single mean`, runs: rs });

  const homoTeams = new Map<string, Map<string, BenchmarkRun[]>>([[HAIKU_LABEL, haikuByInstance]]);
  for (const [model, rs] of newTeams) {
    const byInst = new Map<string, BenchmarkRun[]>();
    for (const r of rs) byInst.set(r.instanceId, [...(byInst.get(r.instanceId) ?? []), r]);
    homoTeams.set(model, byInst);
  }
  for (const [label, teams] of homoTeams) rowSpecs.push(...teamRows(`homo ${label}`, teams));

  const heteroTeams = new Map<string, BenchmarkRun[]>();
  for (const instanceId of INSTANCE_IDS) {
    const members: BenchmarkRun[] = [];
    const h = haikuByInstance.get(instanceId)?.[0];
    if (h) members.push(h);
    for (const [, rs] of newTeams) {
      const m = rs.find((r) => r.instanceId === instanceId);
      if (m) members.push(m);
    }
    if (members.length >= 2) heteroTeams.set(instanceId, members);
  }
  rowSpecs.push(...teamRows("HETERO 3-family", heteroTeams));

  console.log(`\n=== homo vs hetero teams — strict vs semantic (τ=${TAU}) ===`);
  console.log("variant".padEnd(34) + "  f/run   P(s)→P(sem)   R(s)→R(sem)   F1(s)→F1(sem)");
  const report: object[] = [];
  for (const spec of rowSpecs) {
    const s = macro(spec.runs.map((r) => strict.evaluate(r)));
    const m = macro(spec.runs.map((r) => semantic.evaluate(r)));
    const avg = spec.runs.reduce((a, r) => a + r.producedFindings.length, 0) / (spec.runs.length || 1);
    console.log(
      spec.label.padEnd(34) +
        `  ${avg.toFixed(1).padStart(5)}   ${s.p.toFixed(2)}→${m.p.toFixed(2)}     ` +
        `${s.r.toFixed(2)}→${m.r.toFixed(2)}     ${s.f1.toFixed(2)}→${m.f1.toFixed(2)}`,
    );
    report.push({ label: spec.label, avgFindings: avg, strict: s, semantic: m });
  }

  // Diagnostic: golden-match rate by corroboration depth — models vs runs.
  const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
  const matchRate = (teams: Map<string, BenchmarkRun[]>): string => {
    const byDepth = new Map<number, { hit: number; total: number }>();
    for (const [, teamRuns] of teams) {
      const golden = teamRuns[0]!.groundTruth;
      for (const c of clusterTeam(teamRuns)) {
        const d = c.members.size;
        const e = byDepth.get(d) ?? { hit: 0, total: 0 };
        e.total += 1;
        if (golden.some((g) => normPath(g.file) === normPath(c.rep.file) && c.rep.line >= g.lineStart && c.rep.line <= g.lineEnd)) e.hit += 1;
        byDepth.set(d, e);
      }
    }
    return [1, 2, 3].map((d) => {
      const e = byDepth.get(d);
      return e ? `${d}:${((e.hit / e.total) * 100).toFixed(0)}% (n=${e.total})` : `${d}:–`;
    }).join("  ");
  };
  console.log(`\nGolden-match rate by corroboration depth (the verification-signal comparison):`);
  console.log(`  homo ${HAIKU_LABEL}(runs):   ${matchRate(haikuByInstance)}`);
  console.log(`  HETERO (model families):     ${matchRate(heteroTeams)}`);

  writeFileSync(join(OUT_DIR, "hetero-report.json"), JSON.stringify({ tau: TAU, rows: report }, null, 2));
  console.log(`\nreport → ${join(OUT_DIR, "hetero-report.json")}\nExploratory (doc 08); NOT the registered confirmatory analysis.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
