/**
 * hetero-semantic-recluster â€” doc 09 Phase A: re-score the heterogeneous-team
 * experiment with a SEMANTIC cross-model matcher instead of the lexical A4 key.
 *
 * EXPLORATORY, not part of the registered confirmatory analysis.
 *
 * Zero new generation: consumes the persisted doc-08 runs
 * (data/experiments/2026-07-12-hetero-team). The only new LLM calls are
 * findingâ†”finding pair judgments by a FOURTH model family (Nova by default â€”
 * not a team member, not the findingâ†’golden judge), cached and replayable.
 * Both homo and hetero teams are re-clustered with the same instrument, so the
 * instrument upgrade itself cannot confound the comparison; lexical rows are
 * recomputed side by side to quantify the instrument effect (doc 08's
 * mechanism-2 claim).
 *
 * Run:  npm run hetero:recluster                       (defaults below)
 *       MAX_JUDGE_CALLS=0 npm run hetero:recluster     (offline dry run: no LLM,
 *                                                       reports pending-pair cost)
 * Env:  DATA_IN  (=data/experiments/2026-07-12-hetero-team)
 *       OUT_DIR  (=DATA_IN)             pair cache + report land here
 *       PAIR_JUDGE_MODEL (=us.amazon.nova-pro-v1:0)
 *       PAIR_THRESHOLD (=0.7; 0.5/0.9 sensitivity is free from cache)
 *       SEMANTIC_THRESHOLD (=0.7)       findingâ†’golden matching, as registered
 *       MAX_JUDGE_CALLS (=unlimited)    budget knob; script is resumable
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { BenchmarkResult } from "../src/benchmark/models/benchmark-result.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";
import {
  buildFindingPairPrompt,
  clusterFindingsSemantically,
  DEFAULT_PAIR_JUDGE_CONFIG,
  FindingPairScoreCache,
  findingPairKey,
  listCandidatePairs,
  type MemberFinding,
  type SemanticCluster,
} from "../src/benchmark/matching/finding-pair-judge.ts";
import { parseJudgeScore } from "../src/benchmark/matching/judge-prompt.ts";
import { areDuplicateFindings, dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";
import { ProviderRateLimitError, ProviderTimeoutError } from "../src/llm/errors.ts";

const DATA_IN = resolve(process.env.DATA_IN ?? "data/experiments/2026-07-12-hetero-team");
const OUT_DIR = resolve(process.env.OUT_DIR ?? DATA_IN);
const PAIR_TAU = Number(process.env.PAIR_THRESHOLD ?? 0.7);
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const MAX_JUDGE_CALLS = Number(process.env.MAX_JUDGE_CALLS ?? Infinity);
// Nova's sandbox RPM quota is small; default gentle. Resume is cache-cheap.
const PAIR_CONCURRENCY = Math.max(1, Number(process.env.PAIR_CONCURRENCY ?? 2));
const PAIR_JUDGE = {
  ...DEFAULT_PAIR_JUDGE_CONFIG,
  modelId: process.env.PAIR_JUDGE_MODEL ?? DEFAULT_PAIR_JUDGE_CONFIG.modelId,
};

// Families as "label=file" pairs (";"-separated; files resolve against
// DATA_IN, relative segments allowed). The FIRST family is the anchor: its
// instances define the batch and its run #1 supplies groundTruth templates.
// Default = the doc-09 Phase A trio; Phase C overrides via FAMILIES.
const DEFAULT_FAMILIES =
  "haiku-4.5 (frozen)=haiku-agentless-runs.json;" +
  "deepseek.v3.2=hetero-runs-deepseek.v3.2.json;" +
  "llama3.3-70b=hetero-runs-us.meta.llama3-3-70b-instruct-v1_0.json";
const FAMILY_FILES: [string, string][] = (process.env.FAMILIES ?? DEFAULT_FAMILIES)
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const i = entry.indexOf("=");
    return [entry.slice(0, i), entry.slice(i + 1)] as [string, string];
  });
const PRIMARY = FAMILY_FILES[0]![0];
const GOLDEN_CACHE = process.env.GOLDEN_CACHE ?? "golden-judge-cache.json";

// --- load persisted runs -------------------------------------------------------
function loadRuns(file: string): BenchmarkRun[] {
  const p = join(DATA_IN, file);
  if (!existsSync(p)) {
    console.error(`missing ${p} â€” Phase A replays persisted doc-08 runs; see docs/experiment/09.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, "utf8")) as BenchmarkRun[];
}

const families = new Map<string, Map<string, BenchmarkRun[]>>(); // family -> instance -> runs
for (const [label, file] of FAMILY_FILES) {
  const byInstance = new Map<string, BenchmarkRun[]>();
  for (const r of loadRuns(file).filter((x) => x.architecture === "agentless")) {
    byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
  }
  families.set(label, byInstance);
}
const INSTANCE_IDS = [...families.get(PRIMARY)!.keys()];
console.log(
  `hetero-semantic-recluster â€” ${INSTANCE_IDS.length} instances; pair judge ${PAIR_JUDGE.modelId} (Ï„_pair=${PAIR_TAU}, Ï„_sem=${TAU})`,
);

// --- teams: members are within-run-deduped findings tagged by member index -----
type Team = { readonly label: string; readonly byInstance: Map<string, MemberFinding[]> };

function homoTeam(label: string, byInstance: Map<string, BenchmarkRun[]>): Team {
  const out = new Map<string, MemberFinding[]>();
  for (const [instanceId, runs] of byInstance) {
    out.set(
      instanceId,
      runs.flatMap((run, member) => dedupeFindings(run.producedFindings).map((finding) => ({ finding, member }))),
    );
  }
  return { label: `homo ${label}`, byInstance: out };
}

function heteroTeam(): Team {
  const out = new Map<string, MemberFinding[]>();
  for (const instanceId of INSTANCE_IDS) {
    const members: MemberFinding[] = [];
    let member = 0;
    for (const [, byInstance] of families) {
      const run = byInstance.get(instanceId)?.[0];
      if (run) {
        members.push(...dedupeFindings(run.producedFindings).map((finding) => ({ finding, member })));
        member += 1;
      }
    }
    if (member >= 2) out.set(instanceId, members);
  }
  return { label: "HETERO 3-family", byInstance: out };
}

const teams: Team[] = [...[...families.entries()].map(([l, m]) => homoTeam(l, m)), heteroTeam()];

// --- pair judging (resumable; 4th-family judge; budgeted) ----------------------
const pairCachePath = join(OUT_DIR, "pair-judge-cache.json");
const pairCache = existsSync(pairCachePath)
  ? FindingPairScoreCache.fromJSON(JSON.parse(readFileSync(pairCachePath, "utf8")) as Record<string, number>)
  : new FindingPairScoreCache();

function collectUnjudgedPairs(): [ReviewFinding, ReviewFinding][] {
  const seen = new Set<string>();
  const pending: [ReviewFinding, ReviewFinding][] = [];
  for (const team of teams) {
    for (const [, members] of team.byInstance) {
      for (const [a, b] of listCandidatePairs(members)) {
        const key = findingPairKey(a, b);
        if (seen.has(key) || pairCache.has(a, b)) continue;
        seen.add(key);
        pending.push([a, b]);
      }
    }
  }
  return pending;
}

async function judgePendingPairs(): Promise<void> {
  const pending = collectUnjudgedPairs();
  const budget = Math.min(pending.length, MAX_JUDGE_CALLS);
  console.log(`\nPAIR JUDGE â€” ${pending.length} unjudged pairs (${pairCache.size} cached); judging ${budget} now`);
  if (budget === 0) return;

  const { BedrockProvider } = await import("../src/llm/provider/bedrock-provider.ts");
  const provider = new BedrockProvider();
  const queue = pending.slice(0, budget);
  let done = 0;
  let unparseable = 0;
  const flush = (): void => writeFileSync(pairCachePath, JSON.stringify(pairCache.toJSON(), null, 1));

  const worker = async (): Promise<void> => {
    for (;;) {
      const pair = queue.shift();
      if (!pair) return;
      const [a, b] = pair;
      for (let attempt = 1; ; attempt += 1) {
        try {
          const response = await provider.review(buildFindingPairPrompt(a, b, PAIR_JUDGE));
          const score = parseJudgeScore(response.text);
          if (score === undefined) unparseable += 1;
          else pairCache.set(a, b, score);
          break;
        } catch (error) {
          // Rate limits and timeouts back off long; everything else (incl.
          // transient network faults like ENOTFOUND, stream cancels) retries
          // on a short fuse — a single DNS blip must not kill a 1.8k-pair run.
          const throttled = error instanceof ProviderRateLimitError || error instanceof ProviderTimeoutError;
          if (attempt === 12) {
            flush();
            throw error;
          }
          const waitMs = throttled
            ? Math.min(90_000, 2_000 * 2 ** (attempt - 1))
            : Math.min(15_000, 1_000 * 2 ** (attempt - 1));
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      done += 1;
      if (done % 50 === 0) {
        flush();
        console.log(`  judged ${done}/${budget}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PAIR_CONCURRENCY }, worker));
  flush();
  console.log(`  judged ${done} pairs (${unparseable} unparseable responses skipped)`);
}

// --- evaluation ----------------------------------------------------------------
function main(): void {
  const goldenCache = SemanticScoreCache.fromJSON(
    JSON.parse(readFileSync(join(DATA_IN, GOLDEN_CACHE), "utf8")) as Record<string, number>,
  );
  const strict = new GroundTruthEvaluator();
  const semantic = new GroundTruthEvaluator({
    matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(goldenCache), semanticThreshold: TAU }),
  });
  const macro = (rs: BenchmarkResult[]): { p: number; r: number; f1: number } => {
    const n = rs.length || 1;
    return {
      p: rs.reduce((a, x) => a + x.precision, 0) / n,
      r: rs.reduce((a, x) => a + x.recall, 0) / n,
      f1: rs.reduce((a, x) => a + x.f1, 0) / n,
    };
  };

  // A cluster set per (team, instance) â†’ pseudo-run keeping that instance's groundTruth.
  const instanceRun = (instanceId: string): BenchmarkRun => families.get(PRIMARY)!.get(instanceId)![0]!;
  const rowFromClusters = (
    label: string,
    perInstance: Map<string, SemanticCluster[]>,
    minDepth: number,
  ): { label: string; runs: BenchmarkRun[] } => ({
    label,
    runs: [...perInstance.entries()].map(([instanceId, clusters]) => ({
      ...instanceRun(instanceId),
      runId: `${instanceId}#${label}`,
      producedFindings: clusters.filter((c) => c.members.size >= minDepth).map((c) => c.rep),
    })),
  });

  // Lexical (doc-08 instrument) clustering, for the side-by-side instrument effect.
  const lexicalClusters = (members: MemberFinding[]): SemanticCluster[] => {
    const clusters: { rep: ReviewFinding; members: Set<number>; findings: ReviewFinding[] }[] = [];
    for (const { finding, member } of members) {
      const hit = clusters.find((c) => areDuplicateFindings(c.rep, finding));
      if (hit) {
        hit.members.add(member);
        hit.findings.push(finding);
      } else clusters.push({ rep: finding, members: new Set([member]), findings: [finding] });
    }
    return clusters;
  };

  let totalPending = 0;
  const report: object[] = [];
  console.log(`\n=== semantic vs lexical clustering â€” strict / semantic (Ï„_sem=${TAU}) ===`);
  console.log("variant".padEnd(44) + "  f/run   P(s)â†’P(sem)   R(s)â†’R(sem)   F1(s)â†’F1(sem)");

  const emit = (label: string, runs: BenchmarkRun[]): void => {
    const s = macro(runs.map((r) => strict.evaluate(r)));
    const m = macro(runs.map((r) => semantic.evaluate(r)));
    const avg = runs.reduce((a, r) => a + r.producedFindings.length, 0) / (runs.length || 1);
    console.log(
      label.padEnd(44) +
        `  ${avg.toFixed(1).padStart(5)}   ${s.p.toFixed(2)}â†’${m.p.toFixed(2)}     ` +
        `${s.r.toFixed(2)}â†’${m.r.toFixed(2)}     ${s.f1.toFixed(2)}â†’${m.f1.toFixed(2)}`,
    );
    report.push({ label, avgFindings: avg, strict: s, semantic: m });
  };

  // Self-MoA entry gate: single-run mean per family (is the weakest â‰¥85% of the best?).
  const singles = new Map<string, number>();
  for (const [label, byInstance] of families) {
    const runs = [...byInstance.values()].flat();
    emit(`${label} single mean`, runs);
    singles.set(label, macro(runs.map((r) => semantic.evaluate(r))).f1);
  }
  const bestSingle = Math.max(...singles.values());
  console.log(`\nSelf-MoA entry gate (arXiv:2502.00674) â€” family parity vs best (gate: â‰¥0.85):`);
  for (const [label, f1] of singles) {
    const ratio = f1 / (bestSingle || 1);
    console.log(`  ${label.padEnd(24)} F1(sem)=${f1.toFixed(2)}  ratio=${ratio.toFixed(2)} ${ratio >= 0.85 ? "PASS" : "FAIL"}`);
  }
  console.log("");

  for (const team of teams) {
    for (const [instrument, cluster] of [
      ["lexical(A4)", lexicalClusters],
      ["semantic", (m: MemberFinding[]): SemanticCluster[] => {
        const { clusters, pendingPairs } = clusterFindingsSemantically(m, pairCache, PAIR_TAU);
        totalPending += pendingPairs.length;
        return clusters;
      }],
    ] as const) {
      const perInstance = new Map<string, SemanticCluster[]>();
      for (const [instanceId, members] of team.byInstance) perInstance.set(instanceId, cluster(members));
      emit(`  ${team.label} [${instrument}] V0`, rowFromClusters("V0", perInstance, 1).runs);
      emit(`  ${team.label} [${instrument}] V1 k=2`, rowFromClusters("V1k2", perInstance, 2).runs);
      emit(`  ${team.label} [${instrument}] V1 k=3`, rowFromClusters("V1k3", perInstance, 3).runs);
    }
  }

  // Pair-threshold sensitivity for the headline hetero V1 k=2 row (free from cache).
  console.log(`\nPair-threshold sensitivity â€” HETERO [semantic] V1 k=2:`);
  const hetero = teams[teams.length - 1]!;
  for (const tau of [0.5, 0.7, 0.9]) {
    const perInstance = new Map<string, SemanticCluster[]>();
    for (const [instanceId, members] of hetero.byInstance) {
      perInstance.set(instanceId, clusterFindingsSemantically(members, pairCache, tau).clusters);
    }
    emit(`  Ï„_pair=${tau.toFixed(1)}`, rowFromClusters(`V1k2@${tau}`, perInstance, 2).runs);
  }

  // H-hetero diagnostic: golden-match rate by corroboration depth, per instrument.
  const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
  const depthRates = (team: Team, cluster: (m: MemberFinding[]) => SemanticCluster[]): string => {
    const byDepth = new Map<number, { hit: number; total: number }>();
    for (const [instanceId, members] of team.byInstance) {
      const golden = instanceRun(instanceId).groundTruth;
      for (const c of cluster(members)) {
        const strictHit = golden.some(
          (g) => normPath(g.file) === normPath(c.rep.file) && c.rep.line >= g.lineStart && c.rep.line <= g.lineEnd,
        );
        const semHit =
          strictHit ||
          golden.some(
            (g) => normPath(g.file) === normPath(c.rep.file) && (goldenCache.get(c.rep, g) ?? 0) >= TAU,
          );
        const e = byDepth.get(c.members.size) ?? { hit: 0, total: 0 };
        e.total += 1;
        if (semHit) e.hit += 1;
        byDepth.set(c.members.size, e);
      }
    }
    return [1, 2, 3]
      .map((d) => {
        const e = byDepth.get(d);
        return e ? `${d}:${((e.hit / e.total) * 100).toFixed(0)}% (n=${e.total})` : `${d}:â€“`;
      })
      .join("  ");
  };
  console.log(`\nGolden-match rate (semantic) by corroboration depth â€” H-hetero's direct test:`);
  for (const team of [teams[0]!, hetero]) {
    console.log(`  ${team.label.padEnd(24)} lexical:  ${depthRates(team, lexicalClusters)}`);
    console.log(`  ${"".padEnd(24)} semantic: ${depthRates(team, (m) => clusterFindingsSemantically(m, pairCache, PAIR_TAU).clusters)}`);
  }

  if (totalPending > 0) {
    console.log(`\nâš  ${totalPending} candidate pair-evaluations still unjudged (budget/offline run).`);
    console.log(`  Semantic rows above UNDER-merge until judged; re-run without MAX_JUDGE_CALLS to complete.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, "recluster-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify({ pairJudge: PAIR_JUDGE.modelId, pairTau: PAIR_TAU, tau: TAU, pendingPairs: totalPending, rows: report }, null, 2),
  );
  console.log(`\nreport â†’ ${reportPath}\nExploratory (doc 09 Phase A); NOT the registered confirmatory analysis.`);
}

judgePendingPairs()
  .then(main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
