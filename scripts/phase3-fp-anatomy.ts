/**
 * Phase 3 (exploratory) — FALSE-POSITIVE ANATOMY. For findings that match NO
 * ground-truth defect, classify WHERE they go wrong by their positional relation
 * to the injected defects, plus their self-assigned category/severity. ZERO LLM.
 *
 * Location buckets (an FP's line can never fall inside a GT span — that would be a
 * strict TP — so FPs are one of):
 *   A clean-file : FP in a file with NO injected defect      → hallucination OR unlabeled defect
 *   B near-miss  : FP within ±K lines of a real defect (same file) → likely a LOCALIZATION miss
 *   C diff-spot  : FP in a defect-bearing file but far from any defect → different issue / nitpick
 *
 * Populations: (i) agentless single-pass baseline; (ii) the ≥2-family corroborated
 * set (the FPs that fooled multiple independent families — explains Fig-1's <100%).
 *
 * NOTE: structural only. Separating "genuine false alarm" from "real-but-unlabeled
 * defect" (golden incompleteness) in buckets A/C needs a judge/human pass.
 *
 * Env: same as phase3-hetero-stats.ts + NEAR_K (=10).
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";
import {
  clusterFindingsSemantically,
  FindingPairScoreCache,
  type MemberFinding,
} from "../src/benchmark/matching/finding-pair-judge.ts";

const DATA_IN = resolve(process.env.DATA_IN ?? "hetero-confirmatory");
const FAMILIES_ENV =
  process.env.FAMILIES ??
  "haiku-4.5 (frozen)=qodo-all-runs.json;kimi-k2.5=hetero-runs-moonshotai.kimi-k2.5.json;glm-5=hetero-runs-zai.glm-5.json";
const GOLDEN_CACHE = process.env.GOLDEN_CACHE ?? "hetero-cache.json";
const PAIR_CACHE = process.env.PAIR_CACHE ?? "pair-judge-cache.json";
const PAIR_TAU = Number(process.env.PAIR_THRESHOLD ?? 0.7);
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const NEAR_K = Number(process.env.NEAR_K ?? 10);
const DEFAULT_PILOT = [
  "aspnetcore-pr-1", "aspnetcore-pr-2", "aspnetcore-pr-3", "aspnetcore-pr-4",
  "aspnetcore-pr-5", "aspnetcore-pr-6", "aspnetcore-pr-7",
  "Ghost-pr-1", "Ghost-pr-2", "Ghost-pr-3", "Ghost-pr-4", "Ghost-pr-5", "Ghost-pr-6",
  "Ghost-pr-7", "Ghost-pr-8", "Ghost-pr-9", "Ghost-pr-10", "Ghost-pr-11", "Ghost-pr-12",
  "Ghost-pr-13", "swe-1",
].join(",");
const PILOT = new Set((process.env.PILOT_EXCLUDE ?? DEFAULT_PILOT).split(",").map((s) => s.trim()).filter(Boolean));

const FAMILY_FILES: [string, string][] = FAMILIES_ENV.split(";")
  .map((s) => s.trim()).filter(Boolean)
  .map((e) => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)] as [string, string]; });
const PRIMARY = FAMILY_FILES[0]![0];

function loadRuns(file: string): BenchmarkRun[] {
  return (JSON.parse(readFileSync(join(DATA_IN, file), "utf8")) as BenchmarkRun[]).filter((r) => r.architecture === "agentless");
}
const families = new Map<string, Map<string, BenchmarkRun[]>>();
for (const [label, file] of FAMILY_FILES) {
  const byInstance = new Map<string, BenchmarkRun[]>();
  for (const r of loadRuns(file)) byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
  families.set(label, byInstance);
}
const REMAINDER = [...families.get(PRIMARY)!.keys()]
  .filter((id) => !PILOT.has(id))
  .filter((id) => [...families.values()].every((m) => (m.get(id)?.length ?? 0) > 0))
  .sort();

const goldenCache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(join(DATA_IN, GOLDEN_CACHE), "utf8")) as Record<string, number>);
const pairCache = FindingPairScoreCache.fromJSON(JSON.parse(readFileSync(join(DATA_IN, PAIR_CACHE), "utf8")) as Record<string, number>);

const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
const anchorRun = (inst: string): BenchmarkRun => families.get(PRIMARY)!.get(inst)![0]!;
function isTP(f: ReviewFinding, golden: readonly GroundTruthIssue[]): boolean {
  return golden.some((g) => normPath(g.file) === normPath(f.file) &&
    ((f.line >= g.lineStart && f.line <= g.lineEnd) || (goldenCache.get(f, g) ?? 0) >= TAU));
}
function fpBucket(f: ReviewFinding, golden: readonly GroundTruthIssue[]): "A" | "B" | "C" {
  const fileGTs = golden.filter((g) => normPath(g.file) === normPath(f.file));
  if (fileGTs.length === 0) return "A";
  let minDist = Infinity;
  for (const g of fileGTs) {
    const d = f.line < g.lineStart ? g.lineStart - f.line : f.line > g.lineEnd ? f.line - g.lineEnd : 0;
    minDist = Math.min(minDist, d);
  }
  return minDist <= NEAR_K ? "B" : "C";
}
function heteroMembers(inst: string): MemberFinding[] {
  const out: MemberFinding[] = []; let idx = 0;
  for (const byInstance of families.values()) {
    const run = byInstance.get(inst)?.[0];
    if (run) { for (const f of dedupeFindings(run.producedFindings)) out.push({ finding: f, member: idx }); idx += 1; }
  }
  return out;
}

interface FindingCtx { finding: ReviewFinding; golden: readonly GroundTruthIssue[]; }
function anatomize(name: string, items: FindingCtx[]): void {
  let tp = 0;
  const buckets = { A: 0, B: 0, C: 0 };
  const byCat = new Map<string, number>();
  const bySev = new Map<string, number>();
  for (const { finding, golden } of items) {
    if (isTP(finding, golden)) { tp += 1; continue; }
    buckets[fpBucket(finding, golden)] += 1;
    const cat = (finding.category || "(none)").toLowerCase();
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
    bySev.set(finding.severity, (bySev.get(finding.severity) ?? 0) + 1);
  }
  const n = items.length; const fp = n - tp;
  const p = (a: number, b: number): string => (b === 0 ? "0%" : `${((a / b) * 100).toFixed(0)}%`);
  console.log(`\n=== ${name} — ${n} findings; TP ${tp}, FP ${fp} (precision ${p(tp, n)}) ===`);
  console.log(`  FP location: A clean-file ${buckets.A} (${p(buckets.A, fp)})  |  B near-miss ≤${NEAR_K}L ${buckets.B} (${p(buckets.B, fp)})  |  C diff-spot ${buckets.C} (${p(buckets.C, fp)})`);
  console.log(`  FP by category: ${[...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, k]) => `${c}=${k}(${p(k, fp)})`).join("  ")}`);
  console.log(`  FP by severity: ${[...bySev.entries()].sort((a, b) => b[1] - a[1]).map(([s, k]) => `${s}=${k}(${p(k, fp)})`).join("  ")}`);
}

// (i) agentless baseline — all single-pass findings pooled over the 80 PRs
const agentless: FindingCtx[] = [];
for (const inst of REMAINDER) {
  const golden = anchorRun(inst).groundTruth;
  for (const run of families.get(PRIMARY)!.get(inst)!) for (const f of run.producedFindings) agentless.push({ finding: f, golden });
}
// (ii) ≥2-family corroborated set
const corroborated: FindingCtx[] = [];
for (const inst of REMAINDER) {
  const golden = anchorRun(inst).groundTruth;
  for (const c of clusterFindingsSemantically(heteroMembers(inst), pairCache, PAIR_TAU).clusters) {
    if (c.members.size >= 2) corroborated.push({ finding: c.rep, golden });
  }
}

console.log(`phase3-fp-anatomy — ${REMAINDER.length} PRs; near-miss window ±${NEAR_K} lines`);
anatomize("agentless single-pass (baseline)", agentless);
anatomize("≥2-family corroborated set", corroborated);
console.log(`\nBucket A/C = genuine-hallucination vs unlabeled-real-defect is NOT separable structurally — needs a judge/human completeness pass. B ≈ localization misses.`);
