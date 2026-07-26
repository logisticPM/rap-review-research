/**
 * Phase 3 (exploratory) — FALSE-POSITIVE COMPLETENESS pass. An INDEPENDENT judge
 * (Llama 3.3 70B by default — not a generating family; self-preference threat
 * absent) reads each FP finding + its file's diff and answers, WITHOUT the golden
 * set, "does this point at a genuine problem?" → splits FPs into unlabeled-real
 * (golden incompleteness) vs genuine false alarm. Resumable, cached, replayable.
 *
 * Populations: agentless single-pass FPs + the ≥2-family corroborated FPs, over
 * the 80-PR disjoint remainder. Reports real-rate overall, by location bucket
 * (A clean-file / B near-miss / C diff-spot), and by population.
 *
 * Env: DATA_IN, FAMILIES, GOLDEN_CACHE, PAIR_CACHE, PAIR_THRESHOLD,
 *      SEMANTIC_THRESHOLD, NEAR_K, BENCHMARK_DATA_DIR (=<repo>/data/benchmark),
 *      COMPLETENESS_JUDGE (=us.meta.llama3-3-70b-instruct-v1:0),
 *      REAL_THRESHOLD (=0.5), JUDGE_CONCURRENCY (=3), MAX_JUDGE_CALLS (=∞),
 *      OUT (=DATA_IN/fp-completeness).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";
import { clusterFindingsSemantically, FindingPairScoreCache, type MemberFinding } from "../src/benchmark/matching/finding-pair-judge.ts";
import { parseJudgeScore } from "../src/benchmark/matching/judge-prompt.ts";
import { ProviderRateLimitError, ProviderTimeoutError } from "../src/llm/errors.ts";

const DATA_IN = resolve(process.env.DATA_IN ?? "hetero-confirmatory");
const FAMILIES_ENV = process.env.FAMILIES ??
  "haiku-4.5 (frozen)=qodo-all-runs.json;kimi-k2.5=hetero-runs-moonshotai.kimi-k2.5.json;glm-5=hetero-runs-zai.glm-5.json";
const GOLDEN_CACHE = process.env.GOLDEN_CACHE ?? "hetero-cache.json";
const PAIR_CACHE = process.env.PAIR_CACHE ?? "pair-judge-cache.json";
const PAIR_TAU = Number(process.env.PAIR_THRESHOLD ?? 0.7);
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const NEAR_K = Number(process.env.NEAR_K ?? 10);
const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? join(DATA_IN, "..", "data", "benchmark"));
const JUDGE_MODEL = process.env.COMPLETENESS_JUDGE ?? "us.meta.llama3-3-70b-instruct-v1:0";
const REAL_TAU = Number(process.env.REAL_THRESHOLD ?? 0.5);
// "fp" (default): judge golden-UNmatched findings (completeness). "tp": judge
// golden-MATCHED findings (calibration — a discriminating judge should call
// ~all of these real; a rubber-stamp judge calls the same fraction as FPs).
const TARGET = (process.env.TARGET ?? "fp").toLowerCase() === "tp" ? "tp" : "fp";
const CONC = Math.max(1, Number(process.env.JUDGE_CONCURRENCY ?? 3));
const MAX_CALLS = Number(process.env.MAX_JUDGE_CALLS ?? Infinity);
const OUT = resolve(process.env.OUT ?? join(DATA_IN, "fp-completeness"));
const DEFAULT_PILOT = [
  "aspnetcore-pr-1","aspnetcore-pr-2","aspnetcore-pr-3","aspnetcore-pr-4","aspnetcore-pr-5","aspnetcore-pr-6","aspnetcore-pr-7",
  "Ghost-pr-1","Ghost-pr-2","Ghost-pr-3","Ghost-pr-4","Ghost-pr-5","Ghost-pr-6","Ghost-pr-7","Ghost-pr-8","Ghost-pr-9",
  "Ghost-pr-10","Ghost-pr-11","Ghost-pr-12","Ghost-pr-13","swe-1",
].join(",");
const PILOT = new Set((process.env.PILOT_EXCLUDE ?? DEFAULT_PILOT).split(",").map((s) => s.trim()).filter(Boolean));

const FAMILY_FILES: [string, string][] = FAMILIES_ENV.split(";").map((s) => s.trim()).filter(Boolean)
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
const REMAINDER = [...families.get(PRIMARY)!.keys()].filter((id) => !PILOT.has(id))
  .filter((id) => [...families.values()].every((m) => (m.get(id)?.length ?? 0) > 0)).sort();

const goldenCache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(join(DATA_IN, GOLDEN_CACHE), "utf8")) as Record<string, number>);
const pairCache = FindingPairScoreCache.fromJSON(JSON.parse(readFileSync(join(DATA_IN, PAIR_CACHE), "utf8")) as Record<string, number>);

// diffs: qodo.json rows id -> diff
const qodo = JSON.parse(readFileSync(join(DATA_DIR, "qodo.json"), "utf8")) as { rows: { id?: string; diff?: string }[] };
const diffByInstance = new Map<string, string>();
for (const row of qodo.rows) if (row.id && typeof row.diff === "string") diffByInstance.set(row.id, row.diff);

const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
const anchorRun = (inst: string): BenchmarkRun => families.get(PRIMARY)!.get(inst)![0]!;
function isTP(f: ReviewFinding, g: readonly GroundTruthIssue[]): boolean {
  return g.some((x) => normPath(x.file) === normPath(f.file) && ((f.line >= x.lineStart && f.line <= x.lineEnd) || (goldenCache.get(f, x) ?? 0) >= TAU));
}
function bucket(f: ReviewFinding, g: readonly GroundTruthIssue[]): "A" | "B" | "C" {
  const fg = g.filter((x) => normPath(x.file) === normPath(f.file));
  if (fg.length === 0) return "A";
  let m = Infinity;
  for (const x of fg) m = Math.min(m, f.line < x.lineStart ? x.lineStart - f.line : f.line > x.lineEnd ? f.line - x.lineEnd : 0);
  return m <= NEAR_K ? "B" : "C";
}
function heteroMembers(inst: string): MemberFinding[] {
  const out: MemberFinding[] = []; let idx = 0;
  for (const byInstance of families.values()) { const run = byInstance.get(inst)?.[0]; if (run) { for (const f of dedupeFindings(run.producedFindings)) out.push({ finding: f, member: idx }); idx += 1; } }
  return out;
}
// per-file section of a unified diff (bounded), for judge context
function fileDiff(rawDiff: string, file: string): string {
  const parts = rawDiff.split(/(?=^diff --git )/m);
  const hit = parts.find((p) => p.includes(` b/${normPath(file)}`) || p.includes(normPath(file)));
  return (hit ?? rawDiff).slice(0, 8000);
}

interface FPItem { finding: ReviewFinding; instanceId: string; bucket: "A" | "B" | "C"; pops: Set<string>; }
const items = new Map<string, FPItem>();
const key = (inst: string, f: ReviewFinding): string => JSON.stringify([inst, normPath(f.file), f.title, f.description]);
function addFP(inst: string, f: ReviewFinding, golden: readonly GroundTruthIssue[], pop: string): void {
  if (TARGET === "tp" ? !isTP(f, golden) : isTP(f, golden)) return;
  const k = key(inst, f);
  const it = items.get(k) ?? { finding: f, instanceId: inst, bucket: bucket(f, golden), pops: new Set<string>() };
  it.pops.add(pop);
  items.set(k, it);
}
for (const inst of REMAINDER) {
  const golden = anchorRun(inst).groundTruth;
  for (const run of families.get(PRIMARY)!.get(inst)!) for (const f of run.producedFindings) addFP(inst, f, golden, "agentless");
  for (const c of clusterFindingsSemantically(heteroMembers(inst), pairCache, PAIR_TAU).clusters) if (c.members.size >= 2) addFP(inst, c.rep, golden, "corroborated");
}
const allItems = [...items.values()];
console.log(`phase3-fp-completeness [TARGET=${TARGET}] — ${REMAINDER.length} PRs; ${allItems.length} unique ${TARGET.toUpperCase()} findings to judge (judge=${JUDGE_MODEL})`);

// judge cache
mkdirSync(OUT, { recursive: true });
const cachePath = join(OUT, "completeness-cache.json");
const cache: Record<string, number> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

const SYS =
  "You are a strict senior software engineer auditing an automated code review. You are shown a code diff and ONE finding another reviewer raised on it. " +
  "Decide whether the finding identifies a GENUINE problem in the changed code — a real bug, correctness/security/resource issue, or a clearly warranted concern grounded in the diff. " +
  "A vague style nitpick, a subjective preference, or an issue not actually present in the shown code is NOT genuine. " +
  'Respond with ONLY a JSON object {"score": n} where n in [0,1]: 1 = certainly a genuine problem, 0 = certainly not. No other text.';
function userPrompt(it: FPItem): string {
  const d = diffByInstance.get(it.instanceId) ?? "(diff unavailable)";
  const f = it.finding;
  return `## Diff (file: ${f.file})\n\`\`\`diff\n${fileDiff(d, f.file)}\n\`\`\`\n\n## Finding\nfile: ${f.file}\nline: ${f.line}\ntitle: ${f.title}\ndescription: ${f.description}`;
}

async function judgeAll(): Promise<void> {
  const pending = allItems.filter((it) => !(key(it.instanceId, it.finding) in cache));
  const budget = Math.min(pending.length, MAX_CALLS);
  console.log(`PENDING ${pending.length} (${Object.keys(cache).length} cached); judging ${budget} now`);
  if (budget === 0) return;
  const { BedrockProvider } = await import("../src/llm/provider/bedrock-provider.ts");
  const provider = new BedrockProvider();
  const queue = pending.slice(0, budget);
  let done = 0, unparseable = 0;
  const flush = (): void => writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  const worker = async (): Promise<void> => {
    for (;;) {
      const it = queue.shift();
      if (!it) return;
      for (let attempt = 1; ; attempt += 1) {
        try {
          const res = await provider.review({ systemPrompt: SYS, userPrompt: userPrompt(it), modelId: JUDGE_MODEL, temperature: 0, maxTokens: 200 });
          const s = parseJudgeScore(res.text);
          if (s === undefined) unparseable += 1; else cache[key(it.instanceId, it.finding)] = s;
          break;
        } catch (e) {
          const throttled = e instanceof ProviderRateLimitError || e instanceof ProviderTimeoutError;
          if (attempt === 12) { flush(); throw e; }
          await new Promise((r) => setTimeout(r, throttled ? Math.min(90_000, 2_000 * 2 ** (attempt - 1)) : Math.min(15_000, 1_000 * 2 ** (attempt - 1))));
        }
      }
      done += 1;
      if (done % 50 === 0) { flush(); console.log(`  judged ${done}/${budget}`); }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  flush();
  console.log(`  judged ${done} (${unparseable} unparseable)`);
}

function report(): void {
  const judged = allItems.filter((it) => key(it.instanceId, it.finding) in cache);
  const real = (it: FPItem): boolean => (cache[key(it.instanceId, it.finding)] ?? 0) >= REAL_TAU;
  const rate = (arr: FPItem[]): string => (arr.length === 0 ? " – " : `${((arr.filter(real).length / arr.length) * 100).toFixed(0)}% (${arr.filter(real).length}/${arr.length})`);
  console.log(`\n=== ${TARGET === "tp" ? "TP calibration" : "FP completeness"} (judge=${JUDGE_MODEL}, real≥${REAL_TAU}); ${judged.length}/${allItems.length} judged ===`);
  console.log(
    TARGET === "tp"
      ? `"real" rate on GOLDEN-MATCHED findings = calibration ceiling; a discriminating judge → ~high; near the FP rate → rubber-stamp\n`
      : `"unlabeled-real" rate = fraction of FPs the independent judge says ARE genuine problems (⇒ golden incompleteness, reviewer was right)\n`,
  );
  for (const pop of ["agentless", "corroborated"]) {
    const arr = judged.filter((it) => it.pops.has(pop));
    console.log(`${pop.padEnd(14)} overall ${rate(arr)}   | A clean-file ${rate(arr.filter((i) => i.bucket === "A"))}  B near-miss ${rate(arr.filter((i) => i.bucket === "B"))}  C diff-spot ${rate(arr.filter((i) => i.bucket === "C"))}`);
  }
  const corr = judged.filter((it) => it.pops.has("corroborated"));
  const realCorr = corr.filter(real).length;
  console.log(`\nImplication (Fig-1 ceiling): of the ${corr.length} ≥2-family FPs, ${realCorr} look like unlabeled-real defects → the effective ≥2-family precision is higher than the golden-only 72%.`);
  console.log(`Exploratory; judge sees the diff (not full repo); GT-free "is this real?" is harder/subjective than finding→GT matching. Threat: judge shares family with the golden judge (Llama) — a cross-check with a 2nd completeness judge would bound it.`);
  writeFileSync(join(OUT, "fp-completeness-report.json"), JSON.stringify({ judge: JUDGE_MODEL, realTau: REAL_TAU, judged: judged.length, total: allItems.length,
    items: judged.map((it) => ({ instanceId: it.instanceId, file: it.finding.file, line: it.finding.line, title: it.finding.title, bucket: it.bucket, pops: [...it.pops], score: cache[key(it.instanceId, it.finding)] })) }, null, 2));
}

judgeAll().then(report).catch((e) => { console.error(e); process.exit(1); });
