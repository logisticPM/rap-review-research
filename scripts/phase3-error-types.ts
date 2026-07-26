/**
 * Phase 3 (exploratory) — error-TYPE stratification, single vs multi-agent.
 * Zero LLM (replays qodo-all-{runs,cache}.json).
 *
 * Mechanism behind the aggregate tradeoff: WHERE does each arm's precision loss
 * (false-positive noise) and recall gain (detections / misses) live, by defect
 * category? Uses per-item "match-any" semantics (a finding is a TP if it matches
 * ≥1 ground-truth issue via the same semantic matcher as judge:eval; FP if it
 * matches none; a GT issue is a miss if no finding matches it). This differs
 * from the one-to-one bipartite counts behind the headline precision (dedup
 * redundancy is orthogonal to category), so figures are reported as per-run
 * RATES / proportions, comparable across arms.
 *
 * Exploratory (roadmap D2 category-heterogeneity); NOT a registered hypothesis —
 * it explains the confirmatory results.
 *
 * Env: PHASE2_OUT_DIR, RUNS_IN (=<dir>/qodo-all-runs.json),
 *      CACHE_IN (=<dir>/qodo-all-cache.json), SEMANTIC_THRESHOLD (=0.7),
 *      STATS_OUT (=<dir>/phase3-error-types.json).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";

const OUT_DIR = resolve(process.env.PHASE2_OUT_DIR ?? join(import.meta.dirname, "..", "phase2-results"));
const RUNS_IN = process.env.RUNS_IN ?? join(OUT_DIR, "qodo-all-runs.json");
const CACHE_IN = process.env.CACHE_IN ?? join(OUT_DIR, "qodo-all-cache.json");
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const STATS_OUT = process.env.STATS_OUT ?? join(OUT_DIR, "phase3-error-types.json");

const runs = JSON.parse(readFileSync(RUNS_IN, "utf8")) as BenchmarkRun[];
const cache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(CACHE_IN, "utf8")) as Record<string, number>);
const matcher = new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: TAU });
console.log(`loaded ${runs.length} runs, ${Object.keys(cache.toJSON()).length} pairs (τ=${TAU})`);

const ARCHS = ["agentless", "generalists-3", "hierarchical", "consensus"] as const;
type Arch = (typeof ARCHS)[number];
const norm = (c: string | undefined): string => (c ?? "unspecified").trim().toLowerCase() || "unspecified";

interface ArchAgg {
  nRuns: number;
  findingCat: Map<string, number>;   // all produced findings by category
  fpCat: Map<string, number>;        // findings matching NO gt issue
  tpCat: Map<string, number>;        // findings matching >=1 gt issue
  gtCat: Map<string, number>;        // gt issues seen (by run) by gt category
  fnCat: Map<string, number>;        // gt issues matched by NO finding
}
const agg = new Map<Arch, ArchAgg>();
for (const a of ARCHS) agg.set(a, { nRuns: 0, findingCat: new Map(), fpCat: new Map(), tpCat: new Map(), gtCat: new Map(), fnCat: new Map() });
const bump = (m: Map<string, number>, k: string, n = 1): void => { m.set(k, (m.get(k) ?? 0) + n); };

for (const run of runs) {
  const A = agg.get(run.architecture as Arch);
  if (!A) continue;
  A.nRuns += 1;
  for (const f of run.producedFindings) {
    const cat = norm(f.category);
    bump(A.findingCat, cat);
    const isTp = run.groundTruth.some((g) => matcher.match(f, g).matched);
    bump(isTp ? A.tpCat : A.fpCat, cat);
  }
  for (const g of run.groundTruth) {
    const cat = norm(g.category);
    bump(A.gtCat, cat);
    const detected = run.producedFindings.some((f) => matcher.match(f, g).matched);
    if (!detected) bump(A.fnCat, cat);
  }
}

const allCats = (pick: (A: ArchAgg) => Map<string, number>): string[] =>
  [...new Set(ARCHS.flatMap((a) => [...pick(agg.get(a)!).keys()]))].sort();

function table(title: string, pick: (A: ArchAgg) => Map<string, number>, perRun = true): void {
  const cats = allCats(pick);
  console.log(`\n=== ${title} (${perRun ? "per run" : "total"}) ===`);
  console.log("category".padEnd(18) + ARCHS.map((a) => a.padStart(14)).join(""));
  for (const cat of cats) {
    const cells = ARCHS.map((a) => {
      const A = agg.get(a)!;
      const v = pick(A).get(cat) ?? 0;
      return (perRun ? (v / A.nRuns).toFixed(2) : String(v)).padStart(14);
    });
    console.log(cat.padEnd(18) + cells.join(""));
  }
  const totals = ARCHS.map((a) => {
    const A = agg.get(a)!;
    const t = [...pick(A).values()].reduce((s, x) => s + x, 0);
    return (perRun ? (t / A.nRuns).toFixed(2) : String(t)).padStart(14);
  });
  console.log("TOTAL".padEnd(18) + totals.join(""));
}

console.log(`\nruns/arch: ${ARCHS.map((a) => `${a}=${agg.get(a)!.nRuns}`).join("  ")}`);
table("Findings produced by category", (A) => A.findingCat);
table("FALSE POSITIVES by category (noise profile)", (A) => A.fpCat);
table("TRUE POSITIVES by category (detection profile)", (A) => A.tpCat);
table("MISSES (FN) by ground-truth category", (A) => A.fnCat);

// recall by GT category = 1 - fn/gt
console.log(`\n=== recall by ground-truth category (1 − FN/GT) ===`);
const gtCats = allCats((A) => A.gtCat);
console.log("gt-category".padEnd(18) + ARCHS.map((a) => a.padStart(14)).join(""));
for (const cat of gtCats) {
  const cells = ARCHS.map((a) => {
    const A = agg.get(a)!;
    const gt = A.gtCat.get(cat) ?? 0;
    const fn = A.fnCat.get(cat) ?? 0;
    return (gt > 0 ? (1 - fn / gt).toFixed(2) : "–").padStart(14);
  });
  console.log(cat.padEnd(18) + cells.join(""));
}

const toObj = (m: Map<string, number>): Record<string, number> => Object.fromEntries(m);
writeFileSync(STATS_OUT, JSON.stringify({
  tau: TAU,
  arms: Object.fromEntries(ARCHS.map((a) => {
    const A = agg.get(a)!;
    return [a, { nRuns: A.nRuns, findingCat: toObj(A.findingCat), fpCat: toObj(A.fpCat), tpCat: toObj(A.tpCat), gtCat: toObj(A.gtCat), fnCat: toObj(A.fnCat) }];
  })),
}, null, 2));
console.log(`\nwrote → ${STATS_OUT}\nExploratory (D2); explains the confirmatory tradeoff. match-any semantics; per-run rates.`);
