/**
 * Phase 3 (exploratory) — H-hetero corroboration signal STRATIFIED BY DEFECT
 * TYPE. Qodo injects two kinds of defect: rule/best-practice violations (carry a
 * rule_name → GT `category`) and functional/logical bugs (no category). Question:
 * is the cross-family corroboration signal uniform, or does it concentrate on the
 * syntactically-obvious rule violations while functional bugs (which need
 * reasoning, so models diverge) stay at low depth? ZERO LLM calls.
 *
 * Reports, on the 80-PR disjoint remainder:
 *  (1) category-stratified RECALL-at-depth — of each defect type's GT issues, what
 *      fraction are caught by ≥1 / ≥2 / ≥3 independent sources (cross-family vs
 *      same-model 3-run);
 *  (2) COMPOSITION of the ≥2-source-corroborated finding set by category (what the
 *      trustworthy class is actually made of, incl. false positives).
 *
 * Env: same as phase3-hetero-stats.ts (DATA_IN, FAMILIES, GOLDEN_CACHE,
 *      PAIR_CACHE, PAIR_THRESHOLD, SEMANTIC_THRESHOLD, PILOT_EXCLUDE).
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
function heteroMembers(inst: string): MemberFinding[] {
  const out: MemberFinding[] = []; let idx = 0;
  for (const byInstance of families.values()) {
    const run = byInstance.get(inst)?.[0];
    if (run) { for (const finding of dedupeFindings(run.producedFindings)) out.push({ finding, member: idx }); idx += 1; }
  }
  return out;
}
function homoMembers(label: string, inst: string): MemberFinding[] {
  const runs = families.get(label)!.get(inst) ?? [];
  return runs.flatMap((run, member) => dedupeFindings(run.producedFindings).map((finding) => ({ finding, member })));
}
function matches(rep: ReviewFinding, g: GroundTruthIssue): boolean {
  return normPath(g.file) === normPath(rep.file) &&
    ((rep.line >= g.lineStart && rep.line <= g.lineEnd) || (goldenCache.get(rep, g) ?? 0) >= TAU);
}
type Cat = "rule" | "func";
const bucket = (g: GroundTruthIssue): Cat => (g.category && g.category.trim() ? "rule" : "func");

// (1) category-stratified recall-at-depth
const tot: Record<Cat, number> = { rule: 0, func: 0 };
const zero = (): { d1: number; d2: number; d3: number } => ({ d1: 0, d2: 0, d3: 0 });
const caughtH: Record<Cat, { d1: number; d2: number; d3: number }> = { rule: zero(), func: zero() };
const caughtM: Record<Cat, { d1: number; d2: number; d3: number }> = { rule: zero(), func: zero() };
// (2) composition of the ≥2-family corroborated finding set
const comp = { ruleTP: 0, funcTP: 0, fp: 0 };

for (const inst of REMAINDER) {
  const golden = anchorRun(inst).groundTruth;
  const hClusters = clusterFindingsSemantically(heteroMembers(inst), pairCache, PAIR_TAU).clusters;
  const mClusters = clusterFindingsSemantically(homoMembers(PRIMARY, inst), pairCache, PAIR_TAU).clusters;

  const maxDepth = (clusters: typeof hClusters): Map<number, number> => {
    const m = new Map<number, number>();
    for (const c of clusters) golden.forEach((g, gi) => { if (matches(c.rep, g)) m.set(gi, Math.max(m.get(gi) ?? 0, c.members.size)); });
    return m;
  };
  const hD = maxDepth(hClusters);
  const mD = maxDepth(mClusters);
  golden.forEach((g, gi) => {
    const cat = bucket(g); tot[cat] += 1;
    const hd = hD.get(gi) ?? 0; const md = mD.get(gi) ?? 0;
    if (hd >= 1) caughtH[cat].d1 += 1; if (hd >= 2) caughtH[cat].d2 += 1; if (hd >= 3) caughtH[cat].d3 += 1;
    if (md >= 1) caughtM[cat].d1 += 1; if (md >= 2) caughtM[cat].d2 += 1; if (md >= 3) caughtM[cat].d3 += 1;
  });

  for (const c of hClusters) {
    if (c.members.size < 2) continue;
    const hit = golden.find((g) => matches(c.rep, g));
    if (!hit) comp.fp += 1;
    else if (bucket(hit) === "rule") comp.ruleTP += 1;
    else comp.funcTP += 1;
  }
}

const pct = (a: number, b: number): string => (b === 0 ? "  –  " : `${((a / b) * 100).toFixed(0)}%`.padStart(5));
console.log(`phase3-hetero-by-category — ${REMAINDER.length} PRs; GT: rule-violations=${tot.rule}, functional-bugs=${tot.func}\n`);
console.log(`=== (1) recall-at-depth by defect type: fraction of that type's GT caught by ≥k independent sources ===`);
console.log(`defect type            source          ≥1        ≥2        ≥3`);
for (const cat of ["rule", "func"] as Cat[]) {
  const name = cat === "rule" ? "rule-violation" : "functional-bug";
  const h = caughtH[cat]; const m = caughtM[cat];
  console.log(`${name.padEnd(18)} cross-family    ${pct(h.d1, tot[cat])}     ${pct(h.d2, tot[cat])}     ${pct(h.d3, tot[cat])}`);
  console.log(`${"".padEnd(18)} same-model×3    ${pct(m.d1, tot[cat])}     ${pct(m.d2, tot[cat])}     ${pct(m.d3, tot[cat])}`);
}
console.log(`\n=== (2) composition of the ≥2-family corroborated finding set (the "trustworthy" class) ===`);
const compTot = comp.ruleTP + comp.funcTP + comp.fp;
console.log(`  rule-violation TP: ${comp.ruleTP} (${pct(comp.ruleTP, compTot).trim()})   functional-bug TP: ${comp.funcTP} (${pct(comp.funcTP, compTot).trim()})   false-positive: ${comp.fp} (${pct(comp.fp, compTot).trim()})`);
console.log(`  → precision of ≥2-family set = ${pct(comp.ruleTP + comp.funcTP, compTot).trim()} (${comp.ruleTP + comp.funcTP}/${compTot})`);
console.log(`\nExploratory (doc 09 arc); small per-cell n when split by type — directional. Golden incompleteness hits functional bugs hardest → their recall is a lower bound.`);
