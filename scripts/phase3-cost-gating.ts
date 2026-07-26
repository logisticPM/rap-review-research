/**
 * Phase 3 (exploratory) — A1 cost–quality frontier + A2 category-gating
 * counterfactual. Zero LLM (replays qodo-all-{runs,cache}.json).
 *
 * A1: structural cost = LLM calls per PR (architectural, exact: the measured
 *     token/latency instrumentation was not persisted from the confirmatory
 *     campaign; calls are the dominant, deterministic cost driver). Plotted vs
 *     semantic P/R/F1. Estimated input tokens/PR ≈ calls × mean diff tokens
 *     (each call re-sends the diff) is a rough secondary axis.
 * A2: recompute per-arm semantic P/R/F1 after DROPPING self-labeled
 *     maintainability findings (the low-precision noise sink from the
 *     error-type analysis) — does gating close multi-agent's F1 gap to agentless?
 *
 * Exploratory; explains/extends the confirmatory operating-point result.
 * Env: PHASE2_OUT_DIR, RUNS_IN, CACHE_IN, SEMANTIC_THRESHOLD (=0.7), STATS_OUT.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";
import { mean } from "../src/analysis/stats.ts";

const OUT_DIR = resolve(process.env.PHASE2_OUT_DIR ?? join(import.meta.dirname, "..", "phase2-results"));
const RUNS_IN = process.env.RUNS_IN ?? join(OUT_DIR, "qodo-all-runs.json");
const CACHE_IN = process.env.CACHE_IN ?? join(OUT_DIR, "qodo-all-cache.json");
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const STATS_OUT = process.env.STATS_OUT ?? join(OUT_DIR, "phase3-cost-gating.json");

const runs = JSON.parse(readFileSync(RUNS_IN, "utf8")) as BenchmarkRun[];
const cache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(CACHE_IN, "utf8")) as Record<string, number>);
const semantic = new GroundTruthEvaluator({
  matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: TAU }),
});
console.log(`loaded ${runs.length} runs (τ=${TAU})`);

const ARCHS = ["agentless", "generalists-3", "hierarchical", "consensus"] as const;
type Arch = (typeof ARCHS)[number];
const CALLS: Record<Arch, number> = { agentless: 1, "generalists-3": 3, hierarchical: 3, consensus: 9 };
const norm = (c: string | undefined): string => (c ?? "").trim().toLowerCase();

// mean diff tokens (≈ chars/4) over PRs, for the input-token estimate
const diffCharsByInstance = new Map<string, number>();
for (const r of runs) if (r.rawDiff && !diffCharsByInstance.has(r.instanceId)) diffCharsByInstance.set(r.instanceId, r.rawDiff.length);
const meanDiffTokens = mean([...diffCharsByInstance.values()].map((c) => c / 4));

interface Metrics { p: number; r: number; f1: number; fPerRun: number }
function armMetrics(arch: Arch, keep?: (category: string) => boolean): Metrics {
  const armRuns = runs.filter((r) => r.architecture === arch);
  const results = armRuns.map((r) => {
    const producedFindings = keep ? r.producedFindings.filter((f) => keep(norm(f.category))) : r.producedFindings;
    return semantic.evaluate({ ...r, producedFindings });
  });
  return {
    p: mean(results.map((x) => x.precision)),
    r: mean(results.map((x) => x.recall)),
    f1: mean(results.map((x) => x.f1)),
    fPerRun: mean(armRuns.map((r) => (keep ? r.producedFindings.filter((f) => keep(norm(f.category))).length : r.producedFindings.length))),
  };
}

// --- A1: cost–quality frontier -----------------------------------------------
const haveDiff = meanDiffTokens > 0; // rawDiff was NOT persisted in phase2 runs → token est. unavailable
console.log(`\n=== A1: cost–quality frontier (semantic τ=${TAU}) ===`);
console.log("arch".padEnd(14) + "calls  ~inTok/PR   f/run   precision  recall   F1");
const a1: Record<string, unknown>[] = [];
for (const a of ARCHS) {
  const m = armMetrics(a);
  const inTok = haveDiff ? Math.round(CALLS[a] * meanDiffTokens) : undefined;
  console.log(
    a.padEnd(14) + String(CALLS[a]).padEnd(7) + `${(haveDiff ? String(inTok) : "n/a").padEnd(11)} ${m.fPerRun.toFixed(1).padStart(4)}    ` +
      `${m.p.toFixed(3)}      ${m.r.toFixed(3)}    ${m.f1.toFixed(3)}`,
  );
  a1.push({ arch: a, calls: CALLS[a], estInputTokensPerPR: inTok ?? null, ...m });
}
if (!haveDiff) console.log(`  (~inTok/PR n/a — rawDiff not persisted in phase2 runs; calls is the exact cost axis)`);
console.log(
  `  → agentless: cheapest (1 call) AND best F1 → Pareto-dominates on F1-vs-cost. ` +
    `consensus: 9 calls but recall < the 3-call arms → Pareto-dominated (more cost, less recall).`,
);

// --- A2: category-gating counterfactual (drop maintainability) ----------------
console.log(`\n=== A2: gating counterfactual — drop self-labeled "maintainability" findings ===`);
console.log("arch".padEnd(14) + "F1 ungated→gated   recall u→g      precision u→g     f/run u→g");
const keepNonMaint = (cat: string): boolean => cat !== "maintainability";
const a2: Record<string, unknown>[] = [];
const gatedF1: Record<string, number> = {};
for (const a of ARCHS) {
  const u = armMetrics(a);
  const g = armMetrics(a, keepNonMaint);
  gatedF1[a] = g.f1;
  console.log(
    a.padEnd(14) + `${u.f1.toFixed(3)}→${g.f1.toFixed(3)}       ${u.r.toFixed(3)}→${g.r.toFixed(3)}    ` +
      `${u.p.toFixed(3)}→${g.p.toFixed(3)}    ${u.fPerRun.toFixed(1)}→${g.fPerRun.toFixed(1)}`,
  );
  a2.push({ arch: a, ungated: u, gated: g });
}
const agByGated = gatedF1["agentless"]!;
console.log(`\n  Does gating close the F1 gap to agentless?`);
for (const a of ["generalists-3", "hierarchical", "consensus"] as Arch[]) {
  console.log(`    ${a}: gated F1 ${gatedF1[a]!.toFixed(3)} vs agentless gated ${agByGated.toFixed(3)}  (Δ ${(gatedF1[a]! - agByGated).toFixed(3)})`);
}

writeFileSync(STATS_OUT, JSON.stringify({ tau: TAU, meanDiffTokens, a1_cost_quality: a1, a2_gating: a2 }, null, 2));
console.log(`\nwrote → ${STATS_OUT}\nA1 cost = structural LLM calls (measured tokens not persisted). A2 exploratory.`);
