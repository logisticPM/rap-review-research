/**
 * verifier-auc-corrected — do V2.5/V3 hit a target-side ceiling? (doc 08)
 *
 * EXPLORATORY. Zero LLM calls: replays cached verifier scores against BOTH
 * targets — golden and the completeness-corrected target (golden ∪
 * ≥2-architecture-corroborated clusters, built exactly as in
 * golden-completeness.ts).
 *
 * Motivation: V2.5 (domain case law) and V3 (rubric × sampling) converged on
 * AUC 0.66/0.68 vs golden. If golden is ~55% complete, a verifier that
 * correctly approves a real-but-unlisted finding is scored as a false
 * approval, capping measured AUC below truth. Two tests:
 *   1. AUC vs corrected target should RISE for both verifiers.
 *   2. Three-way mean scores: findings matched by golden, by silver ONLY
 *      (real-but-unlisted, per corroboration), and by neither. If
 *      mean(silver-only) ≈ mean(golden) > mean(neither), the verifiers were
 *      right about exactly the findings golden punished them for.
 *
 * Run:  RUNS_IN=<runs.json> V25_CACHE=<v25.json> V3_CACHE=<v3.json> npm run bon:auc
 * Env:  V25_MODEL (=deepseek.v3.2), V3_MODELS (=deepseek.v3.2), V3_K (=3)
 *       AUC_OUT (optional JSON report)
 *
 * NOTE: V3 cache lookups are batch-index-based, so pooling here reproduces
 * verifier-bon-eval.ts's clustering byte-for-byte (same iteration order).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import { areDuplicateFindings, dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";

const runsIn = process.env.RUNS_IN;
if (!runsIn || !existsSync(runsIn)) {
  console.error("Set RUNS_IN to the persisted runs JSON used by bon:eval.");
  process.exit(1);
}
const runs = JSON.parse(readFileSync(runsIn, "utf8")) as BenchmarkRun[];
const V25_MODEL = process.env.V25_MODEL ?? "deepseek.v3.2";
const V3_MODELS = (process.env.V3_MODELS ?? "deepseek.v3.2").split(",").map((s) => s.trim()).filter(Boolean);
const V3_K = Math.max(1, Number(process.env.V3_K ?? 3));
const V3_CRITERIA_IDS = ["evidence", "correct", "material"]; // must match verifier-bon-eval.ts

type Finding = BenchmarkRun["producedFindings"][number];
const normPath = (p: string): string => p.trim().replace(/^\.\//, "");

// --- caches --------------------------------------------------------------------
type V25Map = Record<string, { real: boolean; conf: number }>;
const v25: V25Map =
  process.env.V25_CACHE && existsSync(process.env.V25_CACHE)
    ? (JSON.parse(readFileSync(process.env.V25_CACHE, "utf8")) as V25Map)
    : {};
type V3Raw = Record<string, Record<string, number>>;
const v3raw: V3Raw =
  process.env.V3_CACHE && existsSync(process.env.V3_CACHE)
    ? (JSON.parse(readFileSync(process.env.V3_CACHE, "utf8")) as V3Raw)
    : {};
if (Object.keys(v25).length === 0 && Object.keys(v3raw).length === 0) {
  console.error("Neither V25_CACHE nor V3_CACHE found — nothing to re-score.");
  process.exit(1);
}

// --- BoN pools, identical to verifier-bon-eval.ts ------------------------------
interface Cluster { readonly rep: Finding; readonly runsWith: Set<number> }
const ARCHES = [...new Set(runs.map((r) => r.architecture))];

function groupByInstance(archRuns: BenchmarkRun[]): Map<string, BenchmarkRun[]> {
  const byInstance = new Map<string, BenchmarkRun[]>();
  for (const r of archRuns) byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
  return byInstance;
}
function clusterInstance(instanceRuns: BenchmarkRun[]): Cluster[] {
  const clusters: Cluster[] = [];
  instanceRuns.forEach((run, runIdx) => {
    for (const finding of dedupeFindings(run.producedFindings)) {
      const hit = clusters.find((c) => areDuplicateFindings(c.rep, finding));
      if (hit) hit.runsWith.add(runIdx);
      else clusters.push({ rep: finding, runsWith: new Set([runIdx]) });
    }
  });
  return clusters;
}
const pools = new Map<string, Map<string, { template: BenchmarkRun; clusters: Cluster[] }>>();
for (const arch of ARCHES) {
  const archPools = new Map<string, { template: BenchmarkRun; clusters: Cluster[] }>();
  for (const [instanceId, instanceRuns] of groupByInstance(runs.filter((r) => r.architecture === arch))) {
    archPools.set(instanceId, { template: instanceRuns[0]!, clusters: clusterInstance(instanceRuns) });
  }
  pools.set(arch, archPools);
}

// --- silver target, identical to golden-completeness.ts -------------------------
const byInstanceAll = new Map<string, BenchmarkRun[]>();
for (const r of runs) byInstanceAll.set(r.instanceId, [...(byInstanceAll.get(r.instanceId) ?? []), r]);

const silverOnlyByInstance = new Map<string, GroundTruthIssue[]>();
for (const [instanceId, instanceRuns] of byInstanceAll) {
  const golden = instanceRuns[0]!.groundTruth;
  const clusters: { rep: Finding; file: string; lines: number[]; arches: Set<string> }[] = [];
  for (const run of instanceRuns) {
    for (const f of dedupeFindings(run.producedFindings)) {
      const hit = clusters.find((c) =>
        areDuplicateFindings({ file: c.rep.file, line: c.rep.line, title: c.rep.title }, f),
      );
      if (hit) {
        hit.arches.add(run.architecture);
        hit.lines.push(f.line);
      } else {
        clusters.push({ rep: f, file: f.file, lines: [f.line], arches: new Set([run.architecture]) });
      }
    }
  }
  const silverOnly: GroundTruthIssue[] = [];
  clusters
    .filter(
      (c) =>
        c.arches.size >= 2 &&
        !golden.some((g) => normPath(g.file) === normPath(c.file) && c.lines.some((l) => l >= g.lineStart && l <= g.lineEnd)),
    )
    .forEach((c, i) =>
      silverOnly.push({
        id: `silver-${instanceId}-${i}`,
        file: c.file,
        lineStart: Math.min(...c.lines),
        lineEnd: Math.max(...c.lines),
        title: c.rep.title,
      }),
    );
  silverOnlyByInstance.set(instanceId, silverOnly);
}

// --- score lookups ---------------------------------------------------------------
const v25Score = (instanceId: string, f: Finding): number | undefined => {
  const v = v25[`${V25_MODEL}|${instanceId}|${f.file}|${f.line}|${f.title}`];
  if (!v || v.conf < 0) return undefined; // abstained
  return v.real ? v.conf / 10 : -1 + v.conf / 100; // rejects rank below approvals
};
// V3: mean over criteria × K × models via batch index (idx is the cluster's
// position within its arch×instance pool — identical ordering to bon:eval).
function v3Score(arch: string, instanceId: string, idx: number): number | undefined {
  const scores: number[] = [];
  for (const model of V3_MODELS) {
    for (const cid of V3_CRITERIA_IDS) {
      for (let k = 1; k <= V3_K; k += 1) {
        const s = v3raw[`${model}|${cid}|k${k}|${arch}|${instanceId}`]?.[String(idx + 1)];
        if (typeof s === "number") scores.push(s / 10);
      }
    }
  }
  return scores.length ? scores.reduce((a, x) => a + x, 0) / scores.length : undefined;
}

// --- AUC machinery ---------------------------------------------------------------
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  let ties = 0;
  for (const a of pos) for (const b of neg) { if (a > b) wins += 1; else if (a === b) ties += 1; }
  return (wins + ties / 2) / (pos.length * neg.length);
}
const hits = (f: Finding, issues: readonly GroundTruthIssue[]): boolean =>
  issues.some((g) => normPath(g.file) === normPath(f.file) && f.line >= g.lineStart && f.line <= g.lineEnd);

// --- classify every pooled finding and collect scores -----------------------------
interface Bucket { golden: number[]; silverOnly: number[]; neither: number[] }
const buckets: Record<string, Bucket> = {
  "V2.5": { golden: [], silverOnly: [], neither: [] },
  V3: { golden: [], silverOnly: [], neither: [] },
};
for (const [arch, archPools] of pools) {
  for (const [instanceId, pool] of archPools) {
    const golden = pool.template.groundTruth;
    const silverOnly = silverOnlyByInstance.get(instanceId) ?? [];
    pool.clusters.forEach((c, idx) => {
      const cls: keyof Bucket = hits(c.rep, golden) ? "golden" : hits(c.rep, silverOnly) ? "silverOnly" : "neither";
      const s25 = v25Score(instanceId, c.rep);
      if (s25 !== undefined) buckets["V2.5"]![cls].push(s25);
      const s3 = v3Score(arch, instanceId, idx);
      if (s3 !== undefined) buckets.V3![cls].push(s3);
    });
  }
}

// --- report ------------------------------------------------------------------------
console.log(`verifier-auc-corrected — ${runsIn}`);
console.log(`silver-only clusters available: ${[...silverOnlyByInstance.values()].reduce((a, x) => a + x.length, 0)} across ${silverOnlyByInstance.size} instances\n`);
const report: Record<string, object> = {};
for (const [name, b] of Object.entries(buckets)) {
  const n = b.golden.length + b.silverOnly.length + b.neither.length;
  if (n === 0) continue;
  const aucGolden = auc(b.golden, [...b.silverOnly, ...b.neither]); // golden target: silver-only counts as negative
  const aucCorrected = auc([...b.golden, ...b.silverOnly], b.neither); // corrected target: silver-only is positive
  console.log(`${name} (n=${n} scored findings)`);
  console.log(`  mean score   golden-matched ${mean(b.golden).toFixed(2)} (n=${b.golden.length})   silver-ONLY ${mean(b.silverOnly).toFixed(2)} (n=${b.silverOnly.length})   neither ${mean(b.neither).toFixed(2)} (n=${b.neither.length})`);
  console.log(`  AUC vs golden target:    ${aucGolden.toFixed(3)}`);
  console.log(`  AUC vs corrected target: ${aucCorrected.toFixed(3)}   (Δ ${(aucCorrected - aucGolden >= 0 ? "+" : "")}${(aucCorrected - aucGolden).toFixed(3)})\n`);
  report[name] = {
    n,
    means: { golden: mean(b.golden), silverOnly: mean(b.silverOnly), neither: mean(b.neither) },
    counts: { golden: b.golden.length, silverOnly: b.silverOnly.length, neither: b.neither.length },
    aucGolden,
    aucCorrected,
  };
}
console.log(
  "Reading: if mean(silver-only) ≈ mean(golden) > mean(neither) and AUC rises under the corrected\n" +
    "target, the ~2/3 ceiling was target-side — the verifiers were right about findings golden omits.\n" +
    "Caveat: silver rewards cross-arm agreement (upper bound, not oracle); exploratory.",
);
if (process.env.AUC_OUT) {
  writeFileSync(process.env.AUC_OUT, JSON.stringify(report, null, 2));
  console.log(`\nreport → ${process.env.AUC_OUT}`);
}
