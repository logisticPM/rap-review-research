/**
 * Phase 3 — H-hetero-precision registered paired statistics (OSF amendment,
 * doc 10). ZERO LLM calls: replays the persisted companion runs, the golden
 * finding→GT judge cache (Llama), and the Nova finding↔finding pair-judge cache
 * built by `hetero:recluster`.
 *
 * Registered test set: the DISJOINT REMAINDER of the confirmatory Qodo PRs after
 * excluding the ≤21 pilot PRs used to screen/gate the companion members
 * (Kimi K2.5, GLM 5). The primary (H2) analysis is unaffected and uses the full set.
 *
 * Two registered sub-claims (doc 10, Hypotheses §):
 *   ① Findings corroborated by ≥2 of {Haiku, Kimi, GLM} reach precision ≥ mean
 *      single-arm precision + 10pp, at equal-or-higher F1.
 *   ② Golden-match rate of ALL-THREE-family agreement exceeds that of the frozen
 *      model's ALL-THREE-RUN recurrence by ≥10pp, with the CI excluding a <5pp gap.
 *
 * Stats: PR as unit; paired Wilcoxon signed-rank + Cliff's δ + seeded bootstrap
 * CI (doc 10 Statistical models). Claim ② uses a pooled (micro) rate gap with a
 * PR-level bootstrap because the all-three stratum is sparse per PR. Cross-family
 * clustering is the SAME semantic instrument for homo and hetero (doc 09
 * fairness rule 1). Exploratory diagnostics (depth table) reported alongside.
 *
 * Env: DATA_IN (=hetero-confirmatory), FAMILIES ("label=file;..."; first = anchor),
 *      GOLDEN_CACHE (=hetero-cache.json), PAIR_CACHE (=pair-judge-cache.json),
 *      PAIR_THRESHOLD (=0.7), SEMANTIC_THRESHOLD (=0.7), BOOT_ITERS (=2000),
 *      SEED (=20260715), PILOT_EXCLUDE (csv; default = the 21 pilot PRs),
 *      STATS_OUT (=DATA_IN/phase3-hetero-stats-report.json).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";
import { dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";
import {
  clusterFindingsSemantically,
  FindingPairScoreCache,
  type MemberFinding,
} from "../src/benchmark/matching/finding-pair-judge.ts";
import {
  wilcoxonSignedRank,
  cliffsDelta,
  bootstrapPairedCI,
  bootstrapRateGapCI,
  pooledRateGap,
  holmBonferroni,
  mean,
  median,
  type RatePair,
} from "../src/analysis/stats.ts";

const DATA_IN = resolve(process.env.DATA_IN ?? "hetero-confirmatory");
const FAMILIES_ENV =
  process.env.FAMILIES ??
  "haiku-4.5 (frozen)=qodo-all-runs.json;kimi-k2.5=hetero-runs-moonshotai.kimi-k2.5.json;glm-5=hetero-runs-zai.glm-5.json";
const GOLDEN_CACHE = process.env.GOLDEN_CACHE ?? "hetero-cache.json";
const PAIR_CACHE = process.env.PAIR_CACHE ?? "pair-judge-cache.json";
const PAIR_TAU = Number(process.env.PAIR_THRESHOLD ?? 0.7);
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const BOOT_ITERS = Math.max(200, Number(process.env.BOOT_ITERS ?? 2000));
const SEED = Number(process.env.SEED ?? 20260715);
const STATS_OUT = process.env.STATS_OUT ?? join(DATA_IN, "phase3-hetero-stats-report.json");

// The 21 pilot PRs (doc 09 Phase B/C member screening); excluded from the
// H-hetero-precision confirmatory test (doc 10 Data exclusion). Overridable.
const DEFAULT_PILOT = [
  "aspnetcore-pr-1", "aspnetcore-pr-2", "aspnetcore-pr-3", "aspnetcore-pr-4",
  "aspnetcore-pr-5", "aspnetcore-pr-6", "aspnetcore-pr-7",
  "Ghost-pr-1", "Ghost-pr-2", "Ghost-pr-3", "Ghost-pr-4", "Ghost-pr-5", "Ghost-pr-6",
  "Ghost-pr-7", "Ghost-pr-8", "Ghost-pr-9", "Ghost-pr-10", "Ghost-pr-11", "Ghost-pr-12",
  "Ghost-pr-13", "swe-1",
].join(",");
const PILOT = new Set(
  (process.env.PILOT_EXCLUDE ?? DEFAULT_PILOT).split(",").map((s) => s.trim()).filter(Boolean),
);

// --- load families ("label=file"; first is the anchor: defines the batch + GT) -
const FAMILY_FILES: [string, string][] = FAMILIES_ENV.split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const i = entry.indexOf("=");
    return [entry.slice(0, i), entry.slice(i + 1)] as [string, string];
  });
const PRIMARY = FAMILY_FILES[0]![0];

function loadRuns(file: string): BenchmarkRun[] {
  const runs = JSON.parse(readFileSync(join(DATA_IN, file), "utf8")) as BenchmarkRun[];
  return runs.filter((r) => r.architecture === "agentless");
}
const families = new Map<string, Map<string, BenchmarkRun[]>>();
for (const [label, file] of FAMILY_FILES) {
  const byInstance = new Map<string, BenchmarkRun[]>();
  for (const r of loadRuns(file)) {
    byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
  }
  families.set(label, byInstance);
}

// disjoint remainder: anchor instances where all families are present, minus pilots
const REMAINDER = [...families.get(PRIMARY)!.keys()]
  .filter((id) => !PILOT.has(id))
  .filter((id) => [...families.values()].every((m) => (m.get(id)?.length ?? 0) > 0))
  .sort();

const goldenCache = SemanticScoreCache.fromJSON(
  JSON.parse(readFileSync(join(DATA_IN, GOLDEN_CACHE), "utf8")) as Record<string, number>,
);
const pairCache = FindingPairScoreCache.fromJSON(
  JSON.parse(readFileSync(join(DATA_IN, PAIR_CACHE), "utf8")) as Record<string, number>,
);
const semantic = new GroundTruthEvaluator({
  matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(goldenCache), semanticThreshold: TAU }),
});

console.log(
  `phase3-hetero-stats — families [${FAMILY_FILES.map((f) => f[0]).join(", ")}]; ` +
    `test set = ${REMAINDER.length} PRs (disjoint remainder after ${PILOT.size} pilot exclusions); ` +
    `τ_pair=${PAIR_TAU}, τ_sem=${TAU}, boot=${BOOT_ITERS}`,
);

// --- helpers ------------------------------------------------------------------
const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
function goldenHit(rep: ReviewFinding, golden: readonly GroundTruthIssue[]): boolean {
  return golden.some(
    (g) =>
      normPath(g.file) === normPath(rep.file) &&
      ((rep.line >= g.lineStart && rep.line <= g.lineEnd) || (goldenCache.get(rep, g) ?? 0) >= TAU),
  );
}
const anchorRun = (inst: string): BenchmarkRun => families.get(PRIMARY)!.get(inst)![0]!;
function pseudoRun(inst: string, reps: readonly ReviewFinding[], tag: string): BenchmarkRun {
  return { ...anchorRun(inst), runId: `${inst}#${tag}`, producedFindings: [...reps] };
}
// hetero team: one (first) run per family, within-run deduped, tagged by family index
function heteroMembers(inst: string): MemberFinding[] {
  const members: MemberFinding[] = [];
  let idx = 0;
  for (const byInstance of families.values()) {
    const run = byInstance.get(inst)?.[0];
    if (run) {
      for (const finding of dedupeFindings(run.producedFindings)) members.push({ finding, member: idx });
      idx += 1;
    }
  }
  return members;
}
// homo team for a family: all its runs, within-run deduped, tagged by run index
function homoMembers(label: string, inst: string): MemberFinding[] {
  const runs = families.get(label)!.get(inst) ?? [];
  return runs.flatMap((run, member) => dedupeFindings(run.producedFindings).map((finding) => ({ finding, member })));
}

// --- descriptive: golden-match rate by corroboration depth (the H-hetero diagnostic) ---
function depthTable(members: (inst: string) => MemberFinding[]): Map<number, { hit: number; total: number }> {
  const byDepth = new Map<number, { hit: number; total: number }>();
  for (const inst of REMAINDER) {
    const golden = anchorRun(inst).groundTruth;
    for (const c of clusterFindingsSemantically(members(inst), pairCache, PAIR_TAU).clusters) {
      const e = byDepth.get(c.members.size) ?? { hit: 0, total: 0 };
      e.total += 1;
      if (goldenHit(c.rep, golden)) e.hit += 1;
      byDepth.set(c.members.size, e);
    }
  }
  return byDepth;
}
const fmtDepth = (t: Map<number, { hit: number; total: number }>): string =>
  [1, 2, 3]
    .map((d) => {
      const e = t.get(d);
      return e && e.total > 0 ? `${d}:${((e.hit / e.total) * 100).toFixed(0)}% (n=${e.total})` : `${d}:–`;
    })
    .join("  ");
const heteroDepth = depthTable(heteroMembers);
const homoHaikuDepth = depthTable((inst) => homoMembers(PRIMARY, inst));
console.log(`\n=== golden-match rate by corroboration depth (semantic, ${REMAINDER.length} PRs) ===`);
console.log(`  homo ${PRIMARY.padEnd(20)} ${fmtDepth(homoHaikuDepth)}`);
console.log(`  HETERO 3-family        ${fmtDepth(heteroDepth)}`);

// --- CLAIM ① — precision of ≥2-family corroboration vs mean single-arm ---------
// per-PR (macro), restricted to PRs where ≥2-family corroboration actually occurred.
const c1PrecX: number[] = []; // hetero ≥2-family precision
const c1PrecY: number[] = []; // mean single-arm precision
const c1F1X: number[] = [];
const c1F1Y: number[] = [];
// pooled (micro) accumulators
let hetK2TP = 0;
let hetK2N = 0;
const armTP = new Map<string, number>();
const armN = new Map<string, number>();
for (const inst of REMAINDER) {
  const clusters = clusterFindingsSemantically(heteroMembers(inst), pairCache, PAIR_TAU).clusters;
  const k2reps = clusters.filter((c) => c.members.size >= 2).map((c) => c.rep);
  const hetEval = semantic.evaluate(pseudoRun(inst, k2reps, "hetero-k2"));
  hetK2TP += hetEval.truePositives;
  hetK2N += hetEval.producedCount;

  const armPrec: number[] = [];
  const armF1: number[] = [];
  for (const [label, byInstance] of families) {
    const runs = byInstance.get(inst) ?? [];
    const evals = runs.map((r) => semantic.evaluate(r));
    armPrec.push(mean(evals.map((e) => e.precision)));
    armF1.push(mean(evals.map((e) => e.f1)));
    armTP.set(label, (armTP.get(label) ?? 0) + evals.reduce((a, e) => a + e.truePositives, 0));
    armN.set(label, (armN.get(label) ?? 0) + evals.reduce((a, e) => a + e.producedCount, 0));
  }
  if (k2reps.length > 0) {
    c1PrecX.push(hetEval.precision);
    c1PrecY.push(mean(armPrec));
    c1F1X.push(hetEval.f1);
    c1F1Y.push(mean(armF1));
  }
}
const meanDiff = (a: readonly number[], b: readonly number[]): number => mean(a.map((v, i) => v - b[i]!));
const c1PrecDiffs = c1PrecX.map((x, i) => x - c1PrecY[i]!);
const c1PrecW = wilcoxonSignedRank(c1PrecDiffs);
const c1PrecCI = bootstrapPairedCI(c1PrecX, c1PrecY, meanDiff, { iters: BOOT_ITERS, seed: SEED });
const c1PrecCliff = cliffsDelta(c1PrecX, c1PrecY);
const c1F1W = wilcoxonSignedRank(c1F1X.map((x, i) => x - c1F1Y[i]!));
const c1F1CI = bootstrapPairedCI(c1F1X, c1F1Y, meanDiff, { iters: BOOT_ITERS, seed: SEED });

const pooledHetK2Prec = hetK2N > 0 ? hetK2TP / hetK2N : 0;
const pooledArmPrec = [...families.keys()].map((l) => (armN.get(l)! > 0 ? armTP.get(l)! / armN.get(l)! : 0));
const pooledArmMean = mean(pooledArmPrec);

console.log(`\n=== CLAIM ① — precision of ≥2-family corroboration vs mean single-arm (threshold +0.10) ===`);
console.log(
  `  pooled(micro): hetero≥2fam P=${pooledHetK2Prec.toFixed(3)}  vs  single-arm mean P=${pooledArmMean.toFixed(3)} ` +
    `[${[...families.keys()].map((l, i) => `${l} ${pooledArmPrec[i]!.toFixed(2)}`).join(", ")}]  gap=${(pooledHetK2Prec - pooledArmMean).toFixed(3)}`,
);
console.log(
  `  per-PR paired (n=${c1PrecX.length} PRs with ≥2-fam findings): mean hetero P=${mean(c1PrecX).toFixed(3)} ` +
    `vs mean single-arm P=${mean(c1PrecY).toFixed(3)}  Δ̄=${c1PrecCI.point.toFixed(3)} ` +
    `[${c1PrecCI.lo.toFixed(3)},${c1PrecCI.hi.toFixed(3)}]  wilcoxon p=${c1PrecW.p.toFixed(4)}  δ=${c1PrecCliff.toFixed(3)}`,
);
console.log(
  `  per-PR F1 (equal-or-higher check): mean hetero F1=${mean(c1F1X).toFixed(3)} vs single-arm F1=${mean(c1F1Y).toFixed(3)} ` +
    `Δ̄=${c1F1CI.point.toFixed(3)} [${c1F1CI.lo.toFixed(3)},${c1F1CI.hi.toFixed(3)}]  wilcoxon p=${c1F1W.p.toFixed(4)}`,
);
const c1PrecPass = c1PrecCI.point >= 0.1 && c1PrecCI.lo > 0;
const c1F1Ok = c1F1CI.lo >= -0.02; // "equal or higher" (small tolerance band)
console.log(
  `  → CLAIM ① precision(+10pp): ${c1PrecPass ? "MEETS" : "does NOT meet"} (Δ̄≥0.10 & CI>0); ` +
    `F1 equal-or-higher: ${c1F1Ok ? "OK" : "NOT met"}`,
);

// --- CLAIM ② — all-3-family agreement vs frozen model's 3-run recurrence -------
// per-PR pooled rate gap on the all-three (depth==3) stratum.
const c2Units: RatePair[] = [];
const c2PerPrDiffs: number[] = []; // supplementary paired (PRs where both strata non-empty)
for (const inst of REMAINDER) {
  const golden = anchorRun(inst).groundTruth;
  const het3 = clusterFindingsSemantically(heteroMembers(inst), pairCache, PAIR_TAU).clusters.filter(
    (c) => c.members.size === 3,
  );
  const homo3 = clusterFindingsSemantically(homoMembers(PRIMARY, inst), pairCache, PAIR_TAU).clusters.filter(
    (c) => c.members.size === 3,
  );
  const xHits = het3.filter((c) => goldenHit(c.rep, golden)).length;
  const yHits = homo3.filter((c) => goldenHit(c.rep, golden)).length;
  c2Units.push({ xHits, xN: het3.length, yHits, yN: homo3.length });
  if (het3.length > 0 && homo3.length > 0) c2PerPrDiffs.push(xHits / het3.length - yHits / homo3.length);
}
const c2 = pooledRateGap(c2Units);
const c2CI = bootstrapRateGapCI(c2Units, { iters: BOOT_ITERS, seed: SEED });
const c2W = wilcoxonSignedRank(c2PerPrDiffs);
console.log(`\n=== CLAIM ② — all-3-family vs frozen 3-run golden-match rate (threshold +0.10; CI must exclude <0.05) ===`);
console.log(
  `  pooled: HETERO 3-family ${(c2.xRate * 100).toFixed(0)}% (n=${c2Units.reduce((a, u) => a + u.xN, 0)}) ` +
    `vs homo ${PRIMARY} 3-run ${(c2.yRate * 100).toFixed(0)}% (n=${c2Units.reduce((a, u) => a + u.yN, 0)})`,
);
console.log(
  `  gap=${c2.gap.toFixed(3)}  95% CI [${c2CI.lo.toFixed(3)}, ${c2CI.hi.toFixed(3)}]  ` +
    `(PR-level bootstrap, ${BOOT_ITERS} iters); supplementary per-PR wilcoxon p=${c2W.p.toFixed(4)} (n=${c2PerPrDiffs.length})`,
);
const c2Pass = c2.gap >= 0.1 && c2CI.lo > 0.05;
console.log(`  → CLAIM ② golden-match(+10pp, CI excludes <5pp): ${c2Pass ? "MEETS" : "does NOT meet"}`);

// --- Holm within the two H-hetero p-values (joins the wider secondary family later) ---
const holm = holmBonferroni([c1PrecW.p, c2W.p]);
console.log(
  `\nHolm (local, H-hetero pair): claim① p=${c1PrecW.p.toFixed(4)}→${holm[0]!.toFixed(4)}, ` +
    `claim② p=${c2W.p.toFixed(4)}→${holm[1]!.toFixed(4)}. ` +
    `Final verdict joins the full secondary family (H1/H3/H4/H-verify) under joint Holm.`,
);

writeFileSync(
  STATS_OUT,
  JSON.stringify(
    {
      testSet: { nPRs: REMAINDER.length, pilotExcluded: [...PILOT], instances: REMAINDER },
      params: { tauPair: PAIR_TAU, tauSem: TAU, bootIters: BOOT_ITERS, seed: SEED },
      depthTable: {
        hetero: [1, 2, 3].map((d) => ({ depth: d, ...(heteroDepth.get(d) ?? { hit: 0, total: 0 }) })),
        homoAnchor: [1, 2, 3].map((d) => ({ depth: d, ...(homoHaikuDepth.get(d) ?? { hit: 0, total: 0 }) })),
      },
      claim1: {
        pooled: { heteroK2Precision: pooledHetK2Prec, singleArmMean: pooledArmMean, perArm: pooledArmPrec },
        perPR: {
          n: c1PrecX.length,
          precision: { meanHetero: mean(c1PrecX), meanSingleArm: mean(c1PrecY), meanDiff: c1PrecCI.point, ci: [c1PrecCI.lo, c1PrecCI.hi], wilcoxonP: c1PrecW.p, cliff: c1PrecCliff },
          f1: { meanHetero: mean(c1F1X), meanSingleArm: mean(c1F1Y), meanDiff: c1F1CI.point, ci: [c1F1CI.lo, c1F1CI.hi], wilcoxonP: c1F1W.p },
        },
        precisionMeets: c1PrecPass,
        f1EqualOrHigher: c1F1Ok,
      },
      claim2: {
        heteroRate: c2.xRate,
        homoRate: c2.yRate,
        heteroN: c2Units.reduce((a, u) => a + u.xN, 0),
        homoN: c2Units.reduce((a, u) => a + u.yN, 0),
        gap: c2.gap,
        ci: [c2CI.lo, c2CI.hi],
        perPRWilcoxonP: c2W.p,
        meets: c2Pass,
      },
      holmLocal: { claim1: holm[0], claim2: holm[1] },
    },
    null,
    2,
  ),
);
console.log(`\nwrote report → ${STATS_OUT}\nSECONDARY confirmatory (doc 10 amendment); reported with the secondary family.`);
