/**
 * Phase 3 (exploratory) — metrics borrowed from the external design note
 * ("多模型程序诊断实验分析与改进建议", 2026-07-15), computed on OUR data (80-PR
 * disjoint remainder). ZERO LLM. Five metrics:
 *   1. FDR = 1 − precision (per arm + cross-family).
 *   2. Type-weighted recall — PROXY for severity-weighted recall (Qodo GT carries
 *      NO severity), weighting functional bugs > rule violations.
 *   3. Cost/TP — LLM calls per confirmed (golden) defect (the exact cost axis;
 *      $/token not persisted). calls per single review: agentless 1, gen3 3,
 *      hierarchical 3, consensus 9; cross-family ≥k uses 3 (one run × 3 families).
 *   4. Model marginal value MV_i = ΔTP − λ·ΔFP as each family joins the union
 *      (union de-duplicated by the semantic clusterer); reports ΔTP, ΔFP,
 *      break-even λ = ΔTP/ΔFP (add the model iff review-cost-ratio λ < break-even).
 *   5. Error overlap — cross-family TP & FP by corroboration depth (1/2/3 families);
 *      the counts behind the golden-match-by-depth curve (TP-rate = TP/(TP+FP)).
 *
 * Env: same as phase3-hetero-stats.ts + WEIGHT_FUNC (=3), WEIGHT_RULE (=1).
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";
import { clusterFindingsSemantically, FindingPairScoreCache, type MemberFinding } from "../src/benchmark/matching/finding-pair-judge.ts";

const DATA_IN = resolve(process.env.DATA_IN ?? "hetero-confirmatory");
const FAMILIES_ENV = process.env.FAMILIES ??
  "haiku-4.5 (frozen)=qodo-all-runs.json;kimi-k2.5=hetero-runs-moonshotai.kimi-k2.5.json;glm-5=hetero-runs-zai.glm-5.json";
const GOLDEN_CACHE = process.env.GOLDEN_CACHE ?? "hetero-cache.json";
const PAIR_CACHE = process.env.PAIR_CACHE ?? "pair-judge-cache.json";
const PAIR_TAU = Number(process.env.PAIR_THRESHOLD ?? 0.7);
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const W_FUNC = Number(process.env.WEIGHT_FUNC ?? 3);
const W_RULE = Number(process.env.WEIGHT_RULE ?? 1);
const DEFAULT_PILOT = [
  "aspnetcore-pr-1","aspnetcore-pr-2","aspnetcore-pr-3","aspnetcore-pr-4","aspnetcore-pr-5","aspnetcore-pr-6","aspnetcore-pr-7",
  "Ghost-pr-1","Ghost-pr-2","Ghost-pr-3","Ghost-pr-4","Ghost-pr-5","Ghost-pr-6","Ghost-pr-7","Ghost-pr-8","Ghost-pr-9",
  "Ghost-pr-10","Ghost-pr-11","Ghost-pr-12","Ghost-pr-13","swe-1",
].join(",");
const PILOT = new Set((process.env.PILOT_EXCLUDE ?? DEFAULT_PILOT).split(",").map((s) => s.trim()).filter(Boolean));

const FAMILY_FILES: [string, string][] = FAMILIES_ENV.split(";").map((s) => s.trim()).filter(Boolean)
  .map((e) => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)] as [string, string]; });
const PRIMARY = FAMILY_FILES[0]![0];
const PRIMARY_FILE = FAMILY_FILES[0]![1];

const goldenCache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(join(DATA_IN, GOLDEN_CACHE), "utf8")) as Record<string, number>);
const pairCache = FindingPairScoreCache.fromJSON(JSON.parse(readFileSync(join(DATA_IN, PAIR_CACHE), "utf8")) as Record<string, number>);
const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
function isTP(f: ReviewFinding, g: readonly GroundTruthIssue[]): boolean {
  return g.some((x) => normPath(x.file) === normPath(f.file) && ((f.line >= x.lineStart && f.line <= x.lineEnd) || (goldenCache.get(f, x) ?? 0) >= TAU));
}

// --- load the full 4-arm Haiku campaign + the companion agentless families ------
const allHaikuRuns = JSON.parse(readFileSync(join(DATA_IN, PRIMARY_FILE), "utf8")) as BenchmarkRun[];
const REMAINDER = [...new Set(allHaikuRuns.filter((r) => r.architecture === "agentless").map((r) => r.instanceId))]
  .filter((id) => !PILOT.has(id)).sort();
const inSet = new Set(REMAINDER);
const goldenByInst = new Map<string, readonly GroundTruthIssue[]>();
for (const r of allHaikuRuns) if (inSet.has(r.instanceId) && !goldenByInst.has(r.instanceId)) goldenByInst.set(r.instanceId, r.groundTruth);

const famAgentless = new Map<string, Map<string, BenchmarkRun>>(); // family -> instance -> first agentless run
for (const [label, file] of FAMILY_FILES) {
  const runs = (JSON.parse(readFileSync(join(DATA_IN, file), "utf8")) as BenchmarkRun[]).filter((r) => r.architecture === "agentless");
  const byInst = new Map<string, BenchmarkRun>();
  for (const r of runs) if (inSet.has(r.instanceId) && !byInst.has(r.instanceId)) byInst.set(r.instanceId, r);
  famAgentless.set(label, byInst);
}

console.log(`phase3-borrowed-metrics — ${REMAINDER.length} PRs; weights func=${W_FUNC} rule=${W_RULE}\n`);

// ==== 1 & 3: per-arm FDR + Cost/TP =============================================
const ARMS = ["agentless", "generalists-3", "hierarchical", "consensus"] as const;
const CALLS: Record<string, number> = { agentless: 1, "generalists-3": 3, hierarchical: 3, consensus: 9 };
console.log(`=== 1+3. per-arm precision / FDR / Cost-per-TP (Haiku, ${REMAINDER.length} PRs) ===`);
console.log(`arm            reviews  TP    FP    precision  FDR    calls/review  calls/TP`);
for (const arm of ARMS) {
  const runs = allHaikuRuns.filter((r) => r.architecture === arm && inSet.has(r.instanceId));
  let tp = 0, fp = 0;
  for (const r of runs) for (const f of r.producedFindings) (isTP(f, goldenByInst.get(r.instanceId)!) ? (tp += 1) : (fp += 1));
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const calls = CALLS[arm]!;
  const totalCalls = calls * runs.length;
  console.log(
    `${arm.padEnd(14)} ${String(runs.length).padStart(6)}  ${String(tp).padStart(4)}  ${String(fp).padStart(4)}  ` +
      `${prec.toFixed(3).padStart(8)}  ${(1 - prec).toFixed(3)}  ${String(calls).padStart(11)}  ${(totalCalls / (tp || 1)).toFixed(2).padStart(7)}`,
  );
}

// ==== 2: type-weighted recall (PROXY for severity) =============================
const w = (g: GroundTruthIssue): number => (g.category && g.category.trim() ? W_RULE : W_FUNC);
function coverageRecall(caughtGT: (inst: string) => Set<number>): { unweighted: number; weighted: number } {
  let num = 0, den = 0, wnum = 0, wden = 0;
  for (const inst of REMAINDER) {
    const golden = goldenByInst.get(inst)!;
    const caught = caughtGT(inst);
    golden.forEach((g, gi) => { den += 1; wden += w(g); if (caught.has(gi)) { num += 1; wnum += w(g); } });
  }
  return { unweighted: den ? num / den : 0, weighted: wden ? wnum / wden : 0 };
}
const armCaught = (arm: string) => (inst: string): Set<number> => {
  const golden = goldenByInst.get(inst)!;
  const s = new Set<number>();
  for (const r of allHaikuRuns) if (r.architecture === arm && r.instanceId === inst) for (const f of r.producedFindings) golden.forEach((g, gi) => { if (normPath(g.file) === normPath(f.file) && ((f.line >= g.lineStart && f.line <= g.lineEnd) || (goldenCache.get(f, g) ?? 0) >= TAU)) s.add(gi); });
  return s;
};
console.log(`\n=== 2. type-weighted recall (PROXY — GT has no severity; functional×${W_FUNC} vs rule×${W_RULE}), coverage over 3 runs ===`);
console.log(`arm            unweighted  type-weighted   (weighted>unweighted ⇒ preferentially covers high-stakes functional bugs)`);
for (const arm of ARMS) {
  const r = coverageRecall(armCaught(arm));
  console.log(`${arm.padEnd(14)} ${r.unweighted.toFixed(3).padStart(9)}  ${r.weighted.toFixed(3).padStart(12)}`);
}

// ==== 4 & 5: cross-family union — marginal value + error overlap ================
function members(fams: string[], inst: string): MemberFinding[] {
  const out: MemberFinding[] = [];
  fams.forEach((label, idx) => { const run = famAgentless.get(label)!.get(inst); if (run) for (const f of dedupeFindings(run.producedFindings)) out.push({ finding: f, member: idx }); });
  return out;
}
function unionTPFP(fams: string[]): { tp: number; fp: number } {
  let tp = 0, fp = 0;
  for (const inst of REMAINDER) {
    const golden = goldenByInst.get(inst)!;
    for (const c of clusterFindingsSemantically(members(fams, inst), pairCache, PAIR_TAU).clusters) (isTP(c.rep, golden) ? (tp += 1) : (fp += 1));
  }
  return { tp, fp };
}
const order = FAMILY_FILES.map((f) => f[0]);
console.log(`\n=== 4. model marginal value MV_i = ΔTP − λ·ΔFP as each family joins the union ===`);
console.log(`step                         TP    FP    ΔTP   ΔFP   break-even λ (add iff review-cost λ < this)`);
let prev = { tp: 0, fp: 0 };
for (let k = 1; k <= order.length; k += 1) {
  const cur = unionTPFP(order.slice(0, k));
  const dTP = cur.tp - prev.tp, dFP = cur.fp - prev.fp;
  const be = dFP > 0 ? (dTP / dFP).toFixed(2) : "∞";
  const label = k === 1 ? `base: ${order[0]}` : `+ ${order[k - 1]}`;
  console.log(`${label.padEnd(28)} ${String(cur.tp).padStart(4)}  ${String(cur.fp).padStart(4)}  ${String(dTP).padStart(4)}  ${String(dFP).padStart(4)}   ${be}`);
  prev = cur;
}

console.log(`\n=== 5. error overlap — cross-family clusters by corroboration depth (TP-rate = golden precision at depth) ===`);
const depth: Record<number, { tp: number; fp: number }> = { 1: { tp: 0, fp: 0 }, 2: { tp: 0, fp: 0 }, 3: { tp: 0, fp: 0 } };
for (const inst of REMAINDER) {
  const golden = goldenByInst.get(inst)!;
  for (const c of clusterFindingsSemantically(members(order, inst), pairCache, PAIR_TAU).clusters) {
    const d = c.members.size; if (!depth[d]) continue;
    isTP(c.rep, golden) ? (depth[d]!.tp += 1) : (depth[d]!.fp += 1);
  }
}
console.log(`depth (families agree)   TP    FP    TP-rate (precision at depth)`);
for (const d of [1, 2, 3]) {
  const e = depth[d]!; const tot = e.tp + e.fp;
  console.log(`${String(d).padStart(2)}                       ${String(e.tp).padStart(4)}  ${String(e.fp).padStart(4)}    ${tot ? ((e.tp / tot) * 100).toFixed(0) + "%" : "–"}`);
}
console.log(`\nReading: if the extra TPs from adding a family come with a favorable break-even λ, the family pays; if depth-≥2 TP-rate ≫ depth-1, agreement concentrates truth (complementarity, not noise). All exploratory; golden-only (FP incl. unlabeled-real — see completeness caveat).`);
