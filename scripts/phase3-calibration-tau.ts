/**
 * Phase 3 — τ-sensitivity (robustness) + confidence calibration/filter.
 * Zero LLM (replays qodo-all-{runs,cache}.json).
 *
 * τ-sensitivity: re-evaluate per-arm semantic P/R/F1 at τ∈{0.5,0.7,0.9} and
 *   check the arm RANKING is stable (pre-reg §4: the judge returns near-binary
 *   scores, so any τ∈(0,1) should be equivalent).
 * calibration: bin every finding by its self-reported confidence and measure the
 *   actual TP-rate per bin (match-any at τ=0.7) — is confidence informative?
 * confidence-filter: per-arm P/R/F1 keeping only findings with confidence ≥ c —
 *   is confidence a usable precision lever (like the maintainability gate)?
 *
 * Exploratory / robustness. Env: PHASE2_OUT_DIR, RUNS_IN, CACHE_IN, STATS_OUT.
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
const STATS_OUT = process.env.STATS_OUT ?? join(OUT_DIR, "phase3-calibration-tau.json");

const runs = JSON.parse(readFileSync(RUNS_IN, "utf8")) as BenchmarkRun[];
const cache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(CACHE_IN, "utf8")) as Record<string, number>);
console.log(`loaded ${runs.length} runs`);

const ARCHS = ["agentless", "generalists-3", "hierarchical", "consensus"] as const;
type Arch = (typeof ARCHS)[number];
const evaluatorAt = (tau: number): GroundTruthEvaluator =>
  new GroundTruthEvaluator({ matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: tau }) });

// --- Part 1: τ sensitivity ----------------------------------------------------
const TAUS = [0.5, 0.7, 0.9];
console.log(`\n=== τ-sensitivity: per-arm semantic F1 (recall) at τ ∈ {${TAUS.join(", ")}} ===`);
console.log("arch".padEnd(14) + TAUS.map((t) => `τ=${t}`.padStart(16)).join(""));
const tauReport: Record<string, Record<string, number>> = {};
const f1ByTau = new Map<number, { arch: Arch; f1: number }[]>();
for (const t of TAUS) f1ByTau.set(t, []);
for (const a of ARCHS) {
  const armRuns = runs.filter((r) => r.architecture === a);
  const cells = TAUS.map((t) => {
    const ev = evaluatorAt(t);
    const res = armRuns.map((r) => ev.evaluate(r));
    const f1 = mean(res.map((x) => x.f1));
    const rec = mean(res.map((x) => x.recall));
    f1ByTau.get(t)!.push({ arch: a, f1 });
    tauReport[a] ??= {};
    tauReport[a]![`f1@${t}`] = f1;
    tauReport[a]![`recall@${t}`] = rec;
    return `${f1.toFixed(3)}(${rec.toFixed(2)})`.padStart(16);
  });
  console.log(a.padEnd(14) + cells.join(""));
}
const rankings = TAUS.map((t) => f1ByTau.get(t)!.slice().sort((x, y) => y.f1 - x.f1).map((e) => e.arch).join(" > "));
console.log(`  F1 ranking by τ:`);
TAUS.forEach((t, i) => console.log(`    τ=${t}: ${rankings[i]}`));
console.log(`  → ranking ${new Set(rankings).size === 1 ? "STABLE across τ (robust)" : "CHANGES with τ"}.`);

// --- Part 2: confidence calibration (match-any TP at τ=0.7) -------------------
const m07 = new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: 0.7 });
const points: { conf: number; tp: boolean }[] = [];
for (const r of runs) for (const f of r.producedFindings) {
  points.push({ conf: typeof f.confidence === "number" ? f.confidence : Number.NaN, tp: r.groundTruth.some((g) => m07.match(f, g).matched) });
}
const confs = points.map((p) => p.conf).filter((c) => !Number.isNaN(c));
console.log(`\n=== confidence distribution ===`);
console.log(`  n=${confs.length}  mean=${mean(confs).toFixed(3)}  min=${Math.min(...confs).toFixed(2)}  max=${Math.max(...confs).toFixed(2)}  distinct=${new Set(confs.map((c) => c.toFixed(2))).size}`);
const bins = [[0, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0001]] as const;
console.log(`\n=== calibration: TP-rate (match-any) by confidence bin ===`);
console.log("bin".padEnd(12) + "n".padStart(8) + "meanConf".padStart(12) + "TP-rate".padStart(12));
const calib: Record<string, unknown>[] = [];
for (const [lo, hi] of bins) {
  const inBin = points.filter((p) => !Number.isNaN(p.conf) && p.conf >= lo && p.conf < hi);
  if (inBin.length === 0) continue;
  const tpRate = inBin.filter((p) => p.tp).length / inBin.length;
  const mc = mean(inBin.map((p) => p.conf));
  console.log(`[${lo},${hi === 1.0001 ? "1.0" : hi})`.padEnd(12) + String(inBin.length).padStart(8) + mc.toFixed(3).padStart(12) + tpRate.toFixed(3).padStart(12));
  calib.push({ bin: `[${lo},${hi === 1.0001 ? 1.0 : hi})`, n: inBin.length, meanConf: mc, tpRate });
}

// --- Part 3: confidence filter (precision lever) ------------------------------
console.log(`\n=== confidence filter: per-arm F1 / precision at confidence ≥ c (τ=0.7) ===`);
const cutoffs = [0.0, 0.7, 0.8, 0.9];
const ev07 = evaluatorAt(0.7);
console.log("arch".padEnd(14) + cutoffs.map((c) => `≥${c}`.padStart(16)).join(""));
const filterReport: Record<string, Record<string, number>> = {};
for (const a of ARCHS) {
  const armRuns = runs.filter((r) => r.architecture === a);
  const cells = cutoffs.map((c) => {
    const res = armRuns.map((r) => ev07.evaluate({ ...r, producedFindings: r.producedFindings.filter((f) => (typeof f.confidence === "number" ? f.confidence : 0) >= c) }));
    const f1 = mean(res.map((x) => x.f1));
    const p = mean(res.map((x) => x.precision));
    filterReport[a] ??= {};
    filterReport[a]![`f1@${c}`] = f1;
    filterReport[a]![`prec@${c}`] = p;
    return `${f1.toFixed(3)}/${p.toFixed(2)}`.padStart(16);
  });
  console.log(a.padEnd(14) + cells.join(""));
}
console.log(`  (cells = F1/precision; conf≥0.0 = no filter)`);

writeFileSync(STATS_OUT, JSON.stringify({ tauSensitivity: tauReport, rankings, calibration: calib, confidenceFilter: filterReport }, null, 2));
console.log(`\nwrote → ${STATS_OUT}`);
