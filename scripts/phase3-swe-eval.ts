/**
 * Phase 3 — SWE-PRBench (E2) semantic-coverage aggregate + paired stats, replayed
 * from the persisted `swe-all-{runs,cache}.json` (run phase3-aggregate.ts with
 * AGG_PREFIX=swe first). ZERO LLM calls.
 *
 * `swe:eval` has no RUNS_IN/CACHE_IN replay path (it rebuilds + re-judges each
 * run), so this script re-implements the E2 evaluation over the merged persisted
 * artifacts, reusing the SAME SemanticCoverageEvaluator + CoverageScoreCache.
 * Per (PR, arch) = mean of the 3 runs' coverage/precision/F1; paired per-PR
 * comparisons via src/analysis/stats.ts (Wilcoxon + Cliff's δ + bootstrap CI,
 * Holm within the family).
 *
 * Env: PHASE2_OUT_DIR, RUNS_IN (=<dir>/swe-all-runs.json),
 *      CACHE_IN (=<dir>/swe-all-cache.json), BENCHMARK_DATA_DIR (=<repo>/data/benchmark),
 *      SEMANTIC_THRESHOLD (=0.7), BOOT_ITERS (=2000), STATS_OUT (=<dir>/phase3-swe-report.json).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { GoldenComment } from "../src/benchmark/models/golden-comment.ts";
import { SweGoldenAdapter } from "../src/benchmark/adapters/swe-golden-adapter.ts";
import { CoverageScoreCache } from "../src/benchmark/matching/coverage-score-cache.ts";
import {
  SemanticCoverageEvaluator,
  type SemanticCoverageResult,
} from "../src/benchmark/semantic-coverage-evaluator.ts";
import { wilcoxonSignedRank, cliffsDelta, bootstrapPairedCI, holmBonferroni, mean, median } from "../src/analysis/stats.ts";

const OUT_DIR = resolve(process.env.PHASE2_OUT_DIR ?? join(import.meta.dirname, "..", "phase2-results"));
const RUNS_IN = process.env.RUNS_IN ?? join(OUT_DIR, "swe-all-runs.json");
const CACHE_IN = process.env.CACHE_IN ?? join(OUT_DIR, "swe-all-cache.json");
const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? join(import.meta.dirname, "..", "data", "benchmark"));
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const BOOT_ITERS = Math.max(200, Number(process.env.BOOT_ITERS ?? 2000));
const STATS_OUT = process.env.STATS_OUT ?? join(OUT_DIR, "phase3-swe-report.json");

const runs = JSON.parse(readFileSync(RUNS_IN, "utf8")) as BenchmarkRun[];
const cache = CoverageScoreCache.fromJSON(JSON.parse(readFileSync(CACHE_IN, "utf8")) as Record<string, number>);
const sweDataset = new SweGoldenAdapter().toDataset(JSON.parse(readFileSync(join(DATA_DIR, "swe-golden.json"), "utf8")));
const commentsByInstance = new Map<string, GoldenComment[]>(
  sweDataset.instances.map((i) => [i.instanceId, i.goldenComments]),
);
console.log(`loaded ${runs.length} runs, ${Object.keys(cache.toJSON()).length} coverage pairs, ${commentsByInstance.size} golden PRs (τ=${TAU})`);

const evaluator = new SemanticCoverageEvaluator(TAU);
const ARCHS = ["agentless", "generalists-3", "hierarchical", "consensus"] as const;
type Arch = (typeof ARCHS)[number];

interface Cell { coverage: number; precision: number; f1: number; }
const perPR = new Map<Arch, Map<string, Cell>>();
for (const a of ARCHS) perPR.set(a, new Map());
const byArchInst = new Map<string, SemanticCoverageResult[]>();
for (const r of runs) {
  const key = `${r.architecture} ${r.instanceId}`;
  const res = evaluator.evaluate(r.producedFindings, commentsByInstance.get(r.instanceId) ?? [], cache);
  byArchInst.set(key, [...(byArchInst.get(key) ?? []), res]);
}
for (const [key, results] of byArchInst) {
  const [arch, inst] = key.split(" ") as [Arch, string];
  perPR.get(arch)!.set(inst, {
    coverage: mean(results.map((x) => x.coverage)),
    precision: mean(results.map((x) => x.precision)),
    f1: mean(results.map((x) => x.f1)),
  });
}

console.log(`\n=== SWE E2 semantic coverage (macro mean over PRs, τ=${TAU}) ===`);
console.log("arch".padEnd(14) + "n    coverage  precision   f1");
for (const a of ARCHS) {
  const cells = [...perPR.get(a)!.values()];
  const f = (p: (c: Cell) => number): string => mean(cells.map(p)).toFixed(3);
  console.log(a.padEnd(14) + String(cells.length).padEnd(5) + `${f((c) => c.coverage)}     ${f((c) => c.precision)}      ${f((c) => c.f1)}`);
}

interface Comparison {
  label: string; metric: string; armX: Arch; armY: Arch; n: number;
  meanX: number; meanY: number; medianDiff: number; diffLo: number; diffHi: number;
  wilcoxonP: number; cliff: number; holmP?: number;
}
function compare(label: string, metric: string, armX: Arch, armY: Arch, pick: (c: Cell) => number): Comparison {
  const mx = perPR.get(armX)!; const my = perPR.get(armY)!;
  const xs: number[] = []; const ys: number[] = [];
  for (const [inst, cx] of mx) {
    const cy = my.get(inst);
    if (cy) { xs.push(pick(cx)); ys.push(pick(cy)); }
  }
  const diffs = xs.map((x, i) => x - ys[i]!);
  const w = wilcoxonSignedRank(diffs);
  const diffCI = bootstrapPairedCI(xs, ys, (a, b) => median(a.map((v, i) => v - b[i]!)), { iters: BOOT_ITERS, seed: 20260715 });
  return {
    label, metric, armX, armY, n: xs.length, meanX: mean(xs), meanY: mean(ys),
    medianDiff: diffCI.point, diffLo: diffCI.lo, diffHi: diffCI.hi, wilcoxonP: w.p, cliff: cliffsDelta(xs, ys),
  };
}

console.log(`\n=== E2 ladder — coverage & f1 vs agentless (Holm-corrected within family) ===`);
const family: Comparison[] = [];
for (const a of ["generalists-3", "hierarchical", "consensus"] as Arch[]) {
  family.push(compare(`${a} vs agentless`, "coverage", a, "agentless", (c) => c.coverage));
}
for (const a of ["generalists-3", "hierarchical", "consensus"] as Arch[]) {
  family.push(compare(`agentless vs ${a}`, "f1", "agentless", a, (c) => c.f1));
}
const holm = holmBonferroni(family.map((c) => c.wilcoxonP));
family.forEach((c, i) => { c.holmP = holm[i]; });
for (const c of family) {
  console.log(
    `  ${c.label} [${c.metric}]  ${c.armX}(${c.meanX.toFixed(3)}) vs ${c.armY}(${c.meanY.toFixed(3)})  ` +
      `Δ̃=${c.medianDiff.toFixed(3)} [${c.diffLo.toFixed(3)},${c.diffHi.toFixed(3)}]  ` +
      `wilcoxon p=${c.wilcoxonP.toFixed(4)}  δ=${c.cliff.toFixed(3)}  holm=${c.holmP!.toFixed(4)}`,
  );
}

writeFileSync(STATS_OUT, JSON.stringify({ dataset: "swe-prbench", tau: TAU, bootIters: BOOT_ITERS, nRuns: runs.length, family }, null, 2));
console.log(`\nwrote report → ${STATS_OUT}\nE2 = semantic coverage (no located ground truth); coverage is the recall analogue.`);
