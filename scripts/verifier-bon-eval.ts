/**
 * Verifier-Filtered Best-of-N (VF-BoN) — V0/V1/V2 replay evaluation (doc 08).
 *
 * EXPLORATORY follow-up, not part of the registered confirmatory analysis.
 * Pools each arm's persisted repeated runs into a best-of-N candidate set and
 * applies verifiers of increasing strength:
 *
 *   V0      raw union of the N runs (recall ceiling / precision floor)
 *   V1 (k)  self-consistency: keep findings recurring in >= k distinct runs
 *   V2      LLM-judge binary verifier: "is this a real issue in this diff?"
 *           (batched per arch x instance — the diff is sent once per batch)
 *   V1+V2   both: recurrence AND judged real
 *
 * V0/V1 are zero-cost replay (RUNS_IN + judge CACHE_IN). V2 needs a verifier
 * model; verdicts are cached to VERIFIER_CACHE so re-runs are free. With
 * generation = Haiku (frozen SUT) and semantic matching = Llama, a DeepSeek
 * verifier closes a NON-CIRCULAR triangle: no family judges its own output.
 *
 *   V3      structured continuous verifier (LLM-as-a-Verifier style): 3
 *           adversarial criteria x K stochastic samples -> mean score in [0,1],
 *           thresholded at a swept tau. Panel = mean over V3_MODELS families.
 *
 *   V2.5    exclusion-first binary verifier. Same batched shape as V2, but the
 *           prompt is dominated by domain calibration rather than a bare
 *           question: HARD EXCLUSIONS (what is never a finding), PRECEDENTS
 *           (adjudicated edge cases distilled from this benchmark's observed
 *           false-positive patterns), a SCENARIO TEST (a finding the verifier
 *           cannot write a concrete failure scenario for must be rejected),
 *           an explicit reject-by-default cost statement, and 0-10 confidence
 *           gating. Pattern borrowed from Claude Code's production
 *           security-review prompt (hard-exclusion list + precedent "case
 *           law" + confidence floor), which solves exactly the failure V2
 *           exhibited: a binary judge with no calibration approves ~everything
 *           (17% rejection, AUC ~0.5). Confidence is cached (not booleans), so
 *           threshold sweeps replay free. Hypothesis: domain precedents >
 *           rubric structure (V3) > raw judge intelligence (V2).
 *
 * Run:  RUNS_IN=<runs.json> CACHE_IN=<cache.json> npm run bon:eval
 * Env:  SEMANTIC_THRESHOLD (=0.7), BON_OUT (optional JSON report)
 *       VERIFIER_MODEL (e.g. deepseek.v3.2 — enables V2)
 *       VERIFIER_CACHE (V2 verdict cache JSON, read+write)
 *       V25_MODEL (enables V2.5), V25_CACHE (verdict+confidence cache JSON)
 *       V3_MODELS (comma-separated model ids — enables V3), V3_K (=3),
 *       V3_CACHE (V3 raw-score cache JSON, read+write)
 *       BON_INSTANCES (comma-separated instanceId filter — smoke runs)
 *       BENCHMARK_DATA_DIR (=data/benchmark — diffs for the verifiers)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { BenchmarkResult } from "../src/benchmark/models/benchmark-result.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { IssueMatcher } from "../src/benchmark/matching/issue-matcher.ts";
import { SemanticScoreCache } from "../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../src/benchmark/matching/cached-semantic-matcher.ts";
import {
  areDuplicateFindings,
  dedupeFindings,
} from "../src/architectures/shared/finding-dedup.ts";
import { BenchmarkLoader } from "../src/campaign/index.ts";
import { BedrockProvider } from "../src/llm/provider/bedrock-provider.ts";
import { ProviderRateLimitError, ProviderTimeoutError } from "../src/llm/errors.ts";

const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const VERIFIER_MODEL = process.env.VERIFIER_MODEL;
const VERIFIER_CACHE = process.env.VERIFIER_CACHE;
const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? "data/benchmark");
const DIFF_BUDGET = 500_000; // chars (~125k tokens) — under DeepSeek V3.2's 164K

const runsIn = process.env.RUNS_IN;
const cacheIn = process.env.CACHE_IN;
if (!runsIn || !existsSync(runsIn)) {
  console.error("Set RUNS_IN to a persisted runs JSON (repeated runs, RUNS_PER_INSTANCE >= 2).");
  process.exit(1);
}
if (!cacheIn || !existsSync(cacheIn)) {
  console.error("Set CACHE_IN to the matching persisted judge cache JSON.");
  process.exit(1);
}

const allRuns = JSON.parse(readFileSync(runsIn, "utf8")) as BenchmarkRun[];
const instanceFilter = (process.env.BON_INSTANCES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const runs = instanceFilter.length
  ? allRuns.filter((r) => instanceFilter.includes(r.instanceId))
  : allRuns;
const cache = SemanticScoreCache.fromJSON(JSON.parse(readFileSync(cacheIn, "utf8")));

// --- pool findings per (architecture, instance), tracking run multiplicity ----
type Finding = BenchmarkRun["producedFindings"][number];
interface Cluster {
  readonly rep: Finding;
  readonly runsWith: Set<number>;
}

const ARCHES = [...new Set(runs.map((r) => r.architecture))];
console.log(`VF-BoN replay — ${runsIn}\narchitectures: ${ARCHES.join(", ")}; ${runs.length} runs total`);

function groupByInstance(archRuns: BenchmarkRun[]): Map<string, BenchmarkRun[]> {
  const byInstance = new Map<string, BenchmarkRun[]>();
  for (const r of archRuns) {
    byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
  }
  return byInstance;
}

// Within-run A4 dedup first so a run's internal near-duplicates cannot inflate
// cross-run multiplicity; clustering mirrors dedupeFindings semantics.
function clusterInstance(instanceRuns: BenchmarkRun[]): Cluster[] {
  const clusters: Cluster[] = [];
  instanceRuns.forEach((run, runIdx) => {
    for (const finding of dedupeFindings(run.producedFindings)) {
      const hit = clusters.find((c) => areDuplicateFindings(c.rep, finding));
      if (hit) {
        hit.runsWith.add(runIdx);
      } else {
        clusters.push({ rep: finding, runsWith: new Set([runIdx]) });
      }
    }
  });
  return clusters;
}

interface InstancePool {
  readonly template: BenchmarkRun;
  readonly clusters: Cluster[];
}
const pools = new Map<string, Map<string, InstancePool>>(); // arch -> instanceId -> pool
let maxN = 1;
for (const arch of ARCHES) {
  const byInstance = groupByInstance(runs.filter((r) => r.architecture === arch));
  const archPools = new Map<string, InstancePool>();
  for (const [instanceId, instanceRuns] of byInstance) {
    maxN = Math.max(maxN, instanceRuns.length);
    archPools.set(instanceId, { template: instanceRuns[0]!, clusters: clusterInstance(instanceRuns) });
  }
  pools.set(arch, archPools);
}

// --- V2: batched LLM verifier over the union pools (optional) -----------------
type VerdictMap = Record<string, boolean>; // findingKey -> judged real
const findingKey = (instanceId: string, f: Finding): string =>
  `${VERIFIER_MODEL}|${instanceId}|${f.file}|${f.line}|${f.title}`;

// Diffs come from the benchmark data (persisted runs deliberately omit them).
function loadDiffs(): Map<string, string> {
  const loader = new BenchmarkLoader();
  const diffByInstance = new Map<string, string>();
  for (const [file, load] of [
    ["qodo.json", (raw: unknown) => loader.loadQodo(raw as never)],
    ["swe.json", (raw: unknown) => loader.loadSwe(raw as never)],
  ] as const) {
    const p = resolve(DATA_DIR, file);
    if (!existsSync(p)) continue;
    for (const inst of load(JSON.parse(readFileSync(p, "utf8"))).instances) {
      diffByInstance.set(inst.instanceId, inst.rawDiff);
    }
  }
  return diffByInstance;
}

async function runVerifier(diffByInstance: Map<string, string>): Promise<{ verdicts: VerdictMap; calls: number; unparseable: number }> {
  const verdicts: VerdictMap =
    VERIFIER_CACHE && existsSync(VERIFIER_CACHE)
      ? (JSON.parse(readFileSync(VERIFIER_CACHE, "utf8")) as VerdictMap)
      : {};

  const provider = new BedrockProvider();
  let calls = 0;
  let unparseable = 0;

  for (const [arch, archPools] of pools) {
    for (const [instanceId, pool] of archPools) {
      const reps = pool.clusters.map((c) => c.rep);
      if (reps.length === 0) continue;
      if (reps.every((f) => findingKey(instanceId, f) in verdicts)) continue; // cache hit
      const diff = diffByInstance.get(instanceId);
      if (!diff) {
        console.warn(`  no diff for ${instanceId} — keeping its findings unverified`);
        continue;
      }
      const list = reps
        .map((f, i) => `${i + 1}. [${f.file}:${f.line}] ${f.title} — ${f.description ?? ""}`.slice(0, 700))
        .join("\n");
      const userPrompt =
        `UNIFIED DIFF:\n${diff.slice(0, DIFF_BUDGET)}\n\n` +
        `CANDIDATE REVIEW FINDINGS (${reps.length}):\n${list}\n\n` +
        `For EACH finding, judge strictly against the diff: is it a real, correct issue actually ` +
        `introduced or evidenced by this diff (not speculation the diff contradicts, not a claim ` +
        `about code the diff does not touch)? Respond ONLY with JSON: ` +
        `{"verdicts":[{"n":1,"real":true|false}, ...]} covering every finding number.`;

      let text = "";
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const res = await provider.review({
            modelId: VERIFIER_MODEL!,
            systemPrompt:
              "You are a strict code-review verifier. Judge findings only against the provided diff. Output JSON only.",
            userPrompt,
            temperature: 0,
            maxTokens: 2000,
          });
          text = res.text;
          calls += 1;
          break;
        } catch (error) {
          const transient = error instanceof ProviderRateLimitError || error instanceof ProviderTimeoutError;
          if (!transient || attempt === 4) throw error;
          await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
        }
      }

      let parsed: { verdicts?: { n?: number; real?: boolean }[] } | null = null;
      try {
        parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      } catch {
        parsed = null;
      }
      const byN = new Map((parsed?.verdicts ?? []).map((v) => [v.n, v.real === true]));
      reps.forEach((f, i) => {
        const verdict = byN.get(i + 1);
        // Missing/unparseable verdict = verifier abstained -> KEEP (do not filter).
        if (verdict === undefined) unparseable += 1;
        verdicts[findingKey(instanceId, f)] = verdict ?? true;
      });
      if (VERIFIER_CACHE) writeFileSync(VERIFIER_CACHE, JSON.stringify(verdicts, null, 1)); // checkpoint
      console.log(`  V2 ${arch}/${instanceId}: judged ${reps.length} findings`);
    }
  }
  return { verdicts, calls, unparseable };
}

// --- V2.5: exclusion-first binary verifier (see header) -----------------------
const V25_MODEL = process.env.V25_MODEL;
const V25_CACHE = process.env.V25_CACHE;
type V25Verdict = { readonly real: boolean; readonly conf: number };
type V25Map = Record<string, V25Verdict>; // findingKey25 -> verdict
const findingKey25 = (instanceId: string, f: Finding): string =>
  `${V25_MODEL}|${instanceId}|${f.file}|${f.line}|${f.title}`;

// Exclusions and precedents are the calibration payload. The precedents are
// distilled from THIS pipeline's observed false-positive patterns (doc 08 +
// the golden-completeness audit): generic hardening advice, claims about
// untouched code, diff-contradicted claims, and style dressed up as defects.
const V25_RULES =
  `HARD EXCLUSIONS — reject any finding that is:\n` +
  `E1. Style, naming, formatting, comment wording, or code-organization advice — regardless of its stated severity.\n` +
  `E2. Generic hardening advice ("add validation", "add error handling", "consider rate limiting", "sanitize input") with no specific broken input identified.\n` +
  `E3. Speculation about code the diff does not touch: claims about files or functions visible only as unchanged context, unless a changed line directly interacts with them.\n` +
  `E4. Missing tests, missing documentation, or missing logging.\n` +
  `E5. A theoretical performance concern with no evident hot path in the diff.\n` +
  `E6. A claim the diff itself contradicts (e.g. "X is never checked" when a changed line checks X — read the surrounding hunk).\n` +
  `E7. Concerns purely about error-message text or log wording.\n\n` +
  `PRECEDENTS — adjudicated edge cases; follow them:\n` +
  `P1. "Missing null/undefined/bounds check" is real ONLY when a concrete input reaching the new code produces the bad value; otherwise it is E2.\n` +
  `P2. If neighbouring lines of the same hunk already handle the case the finding describes, the finding is wrong.\n` +
  `P3. A defect visibly introduced on added/changed lines — inverted condition, wrong variable, off-by-one, missing await on a new async call, a resource acquired on a new path and never released — is the target class: approve with high confidence.\n` +
  `P4. A security finding needs an attacker-controlled input path visible in the diff; "could be exploited if user-controlled" without showing the path is E2.\n` +
  `P5. Behavior that is clearly intentional in the PR's context (the diff deliberately renames/removes/changes something and the finding reports it as accidental) is not real.\n` +
  `P6. Torn between "real but minor" and "not real"? The scenario decides: crisp and mechanically checkable → real with conf 5-7; vague → not real.\n\n` +
  `SCENARIO TEST — for each finding FIRST write a one-line failure scenario (<=15 words): the concrete ` +
  `input or state and the wrong outcome (e.g. "empty list -> index -1 -> crash"). If you cannot write ` +
  `one, set "scenario":"none" and the finding MUST be rejected.\n\n` +
  `CONFIDENCE — 0-10: 8-10 certain, you would flag it in a real PR review; 5-7 plausible but unproven; 0-4 speculative or noise.`;

async function runVerifier25(diffByInstance: Map<string, string>): Promise<{ verdicts: V25Map; calls: number; unparseable: number }> {
  const verdicts: V25Map =
    V25_CACHE && existsSync(V25_CACHE) ? (JSON.parse(readFileSync(V25_CACHE, "utf8")) as V25Map) : {};
  const provider = new BedrockProvider();
  let calls = 0;
  let unparseable = 0;

  for (const [arch, archPools] of pools) {
    for (const [instanceId, pool] of archPools) {
      const reps = pool.clusters.map((c) => c.rep);
      if (reps.length === 0) continue;
      if (reps.every((f) => findingKey25(instanceId, f) in verdicts)) continue; // cache hit
      const diff = diffByInstance.get(instanceId);
      if (!diff) {
        console.warn(`  no diff for ${instanceId} — keeping its findings unverified`);
        continue;
      }
      const list = reps
        .map((f, i) => `${i + 1}. [${f.file}:${f.line}] ${f.title} — ${f.description ?? ""}`.slice(0, 700))
        .join("\n");
      const userPrompt =
        `UNIFIED DIFF:\n${diff.slice(0, DIFF_BUDGET)}\n\n` +
        `CANDIDATE REVIEW FINDINGS (${reps.length}):\n${list}\n\n` +
        `TASK: for EACH finding decide whether it is a real, correct issue actually introduced or ` +
        `evidenced by this diff. Your default is REJECT: approve only what survives the exclusions, ` +
        `precedents, and scenario test below. Missing a marginal issue is acceptable; approving noise is not.\n\n` +
        `${V25_RULES}\n\n` +
        `Respond ONLY with JSON: {"verdicts":[{"n":1,"scenario":"...","real":true|false,"conf":<0-10>}, ...]} ` +
        `covering every finding number 1..${reps.length}.`;

      let text = "";
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const res = await provider.review({
            modelId: V25_MODEL!,
            systemPrompt:
              "You are a strict code-review verifier with a reject-by-default policy. Judge findings only " +
              "against the provided diff. Better to miss a marginal issue than to approve noise. Output JSON only.",
            userPrompt,
            temperature: 0,
            maxTokens: 3000,
          });
          text = res.text;
          calls += 1;
          break;
        } catch (error) {
          const transient = error instanceof ProviderRateLimitError || error instanceof ProviderTimeoutError;
          if (!transient || attempt === 4) throw error;
          await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
        }
      }

      let parsed: { verdicts?: { n?: number; real?: boolean; conf?: number }[] } | null = null;
      try {
        parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      } catch {
        parsed = null;
      }
      const byN = new Map(
        (parsed?.verdicts ?? [])
          .filter((v) => typeof v.n === "number")
          .map((v) => [v.n, { real: v.real === true, conf: Math.max(0, Math.min(10, Number(v.conf ?? 0))) }]),
      );
      reps.forEach((f, i) => {
        const verdict = byN.get(i + 1);
        // Missing/unparseable verdict = abstained. Sentinel conf -1: kept at
        // every threshold, excluded from the AUC/rejection diagnostics, and
        // cached so a resume does not re-pay for it.
        if (verdict === undefined) {
          unparseable += 1;
          verdicts[findingKey25(instanceId, f)] = { real: true, conf: -1 };
        } else {
          verdicts[findingKey25(instanceId, f)] = verdict;
        }
      });
      if (V25_CACHE) writeFileSync(V25_CACHE, JSON.stringify(verdicts, null, 1)); // checkpoint
      console.log(`  V2.5 ${arch}/${instanceId}: judged ${reps.length} findings`);
    }
  }
  return { verdicts, calls, unparseable };
}

// --- V3: structured continuous verifier — criteria × K × (optional) panel ----
// LLM-as-a-Verifier structure adapted for no-logprob Bedrock models: the
// continuous score is the mean over C adversarial criteria × K stochastic
// samples (temperature 0.7) × the model panel. Adversarial framing counters the
// leniency V2 exhibited (a flat ~82% "real" rate).
const V3_MODELS = (process.env.V3_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const V3_K = Math.max(1, Number(process.env.V3_K ?? 3));
const V3_CACHE = process.env.V3_CACHE;
// Rubric-anchored criteria. Early wording ("be adversarial: assume NO") made
// the model emit degenerate uniform 0s/10s for whole batches — a binary gate,
// not a score (the granularity failure LLM-as-a-Verifier §scaling warns about).
// Anchored bands + an explicit differentiation instruction elicit a usable range.
const V3_CRITERIA: readonly { id: string; question: string }[] = [
  {
    id: "evidence",
    question:
      "EVIDENCE: how directly does the DIFF ITSELF show the problem this finding describes? " +
      "9-10 the problematic code is visibly introduced/changed in the diff; 6-8 the diff touches " +
      "the relevant code and the problem is a reasonable direct reading; 3-5 only indirect or " +
      "partial support in the diff; 0-2 the diff does not contain what the finding claims.",
  },
  {
    id: "correct",
    question:
      "CORRECTNESS: how likely is the technical claim to be right about this code? " +
      "9-10 a senior engineer would clearly agree; 6-8 plausibly right, minor doubts; " +
      "3-5 questionable or overstated; 0-2 wrong or contradicted by the diff.",
  },
  {
    id: "material",
    question:
      "MATERIALITY: would a maintainer act on this? 9-10 must-fix (bug, security, data loss); " +
      "6-8 worth fixing (real defect or risky pattern); 3-5 minor/nice-to-have; " +
      "0-2 style nitpick, duplicate noise, or speculation about untouched code.",
  },
];

type V3Raw = Record<string, Record<string, number>>; // callKey -> { findingIdx(1-based) -> score 0-10 }

async function runV3(
  diffByInstance: Map<string, string>,
): Promise<{ score: (instanceId: string, f: Finding) => number | undefined; calls: number }> {
  const raw: V3Raw = V3_CACHE && existsSync(V3_CACHE) ? (JSON.parse(readFileSync(V3_CACHE, "utf8")) as V3Raw) : {};
  const provider = new BedrockProvider();
  let calls = 0;

  interface BatchTask {
    readonly arch: string;
    readonly instanceId: string;
    readonly reps: Finding[];
  }
  const tasks: BatchTask[] = [];
  for (const [arch, archPools] of pools) {
    for (const [instanceId, pool] of archPools) {
      const reps = pool.clusters.map((c) => c.rep);
      if (reps.length > 0) tasks.push({ arch, instanceId, reps });
    }
  }

  async function scoreBatch(task: BatchTask): Promise<void> {
    const diff = diffByInstance.get(task.instanceId);
    if (!diff) return;
    const list = task.reps
      .map((f, i) => `${i + 1}. [${f.file}:${f.line}] ${f.title} — ${f.description ?? ""}`.slice(0, 700))
      .join("\n");
    for (const model of V3_MODELS) {
      for (const criterion of V3_CRITERIA) {
        for (let k = 1; k <= V3_K; k += 1) {
          const callKey = `${model}|${criterion.id}|k${k}|${task.arch}|${task.instanceId}`;
          if (callKey in raw) continue;
          const userPrompt =
            `UNIFIED DIFF:\n${diff.slice(0, DIFF_BUDGET)}\n\n` +
            `CANDIDATE REVIEW FINDINGS (${task.reps.length}):\n${list}\n\n` +
            `Score EVERY finding 0-10 on this ONE criterion:\n${criterion.question}\n\n` +
            `The findings differ in quality — your scores MUST differentiate them; do not give ` +
            `the whole list one uniform score. First jot one short comparative note (<=80 words), ` +
            `then respond ONLY with JSON: {"notes":"...","scores":[{"n":1,"s":<0-10>}, ...]} ` +
            `covering every finding number 1..${task.reps.length}.`;
          for (let attempt = 1; attempt <= 4; attempt += 1) {
            try {
              const res = await provider.review({
                modelId: model,
                systemPrompt:
                  "You are a skeptical, calibrated code-review verifier. Judge strictly against the provided diff; award points only for what survives scrutiny, and use the full 0-10 range to rank findings against each other. Output JSON only.",
                userPrompt,
                temperature: 0.7, // stochastic — K samples approximate the score distribution
                maxTokens: 2500,
              });
              calls += 1;
              let parsed: { scores?: { n?: number; s?: number }[] } | null = null;
              try {
                parsed = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
              } catch {
                parsed = null;
              }
              const entry: Record<string, number> = {};
              for (const s of parsed?.scores ?? []) {
                if (typeof s.n === "number" && typeof s.s === "number") entry[String(s.n)] = Math.max(0, Math.min(10, s.s));
              }
              raw[callKey] = entry; // empty object = unparseable; recorded so we don't re-pay
              break;
            } catch (error) {
              const transient = error instanceof ProviderRateLimitError || error instanceof ProviderTimeoutError;
              if (!transient || attempt === 4) throw error;
              await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
            }
          }
        }
      }
    }
    if (V3_CACHE) writeFileSync(V3_CACHE, JSON.stringify(raw)); // checkpoint per batch
    console.log(`  V3 ${task.arch}/${task.instanceId}: ${task.reps.length} findings × ${V3_CRITERIA.length}C × K${V3_K} × ${V3_MODELS.length}M`);
  }

  // Small concurrency pool — batches are independent; 4 in flight is well under
  // every model's requests-per-minute quota.
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) await scoreBatch(t);
    }),
  );
  if (V3_CACHE) writeFileSync(V3_CACHE, JSON.stringify(raw));

  // Aggregate: per finding, mean over criteria × K × models, normalized to [0,1].
  const agg = new Map<string, number[]>(); // instanceId|file|line|title -> scores
  for (const [arch, archPools] of pools) {
    for (const [instanceId, pool] of archPools) {
      pool.clusters.forEach((c, idx) => {
        const fkey = `${instanceId}|${c.rep.file}|${c.rep.line}|${c.rep.title}`;
        for (const model of V3_MODELS) {
          for (const criterion of V3_CRITERIA) {
            for (let k = 1; k <= V3_K; k += 1) {
              const entry = raw[`${model}|${criterion.id}|k${k}|${arch}|${instanceId}`];
              const s = entry?.[String(idx + 1)];
              if (typeof s === "number") agg.set(fkey, [...(agg.get(fkey) ?? []), s / 10]);
            }
          }
        }
      });
    }
  }
  return {
    score: (instanceId, f) => {
      const scores = agg.get(`${instanceId}|${f.file}|${f.line}|${f.title}`);
      return scores?.length ? scores.reduce((a, x) => a + x, 0) / scores.length : undefined;
    },
    calls,
  };
}

// --- evaluate: strict vs semantic, identical wiring to benchmark-judge-eval ---
const strict = new GroundTruthEvaluator();
const semantic = new GroundTruthEvaluator({
  matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: TAU }),
});

function macro(results: BenchmarkResult[]): { p: number; r: number; f1: number } {
  const n = results.length || 1;
  return {
    p: results.reduce((a, x) => a + x.precision, 0) / n,
    r: results.reduce((a, x) => a + x.recall, 0) / n,
    f1: results.reduce((a, x) => a + x.f1, 0) / n,
  };
}

interface Row {
  readonly label: string;
  readonly n: number;
  readonly avgFindings: number;
  readonly strict: { p: number; r: number; f1: number };
  readonly semantic: { p: number; r: number; f1: number };
}

function evaluateRow(label: string, rowRuns: BenchmarkRun[]): Row {
  return {
    label,
    n: rowRuns.length,
    avgFindings: rowRuns.reduce((a, r) => a + r.producedFindings.length, 0) / (rowRuns.length || 1),
    strict: macro(rowRuns.map((r) => strict.evaluate(r))),
    semantic: macro(rowRuns.map((r) => semantic.evaluate(r))),
  };
}

function pooledRuns(
  arch: string,
  label: string,
  keep: (c: Cluster, instanceId: string) => boolean,
): BenchmarkRun[] {
  const archPools = pools.get(arch)!;
  const out: BenchmarkRun[] = [];
  for (const [instanceId, pool] of archPools) {
    const kept = pool.clusters.filter((c) => keep(c, instanceId)).map((c) => c.rep);
    out.push({ ...pool.template, runId: `${instanceId}#bon#${label}`, producedFindings: kept });
  }
  return out;
}

async function main(): Promise<void> {
  const needDiffs = Boolean(VERIFIER_MODEL) || Boolean(V25_MODEL) || V3_MODELS.length > 0;
  const diffs = needDiffs ? loadDiffs() : new Map<string, string>();

  let verdicts: VerdictMap | null = null;
  if (VERIFIER_MODEL) {
    console.log(`\nV2 verifier: ${VERIFIER_MODEL} (batched per arch × instance, cached: ${VERIFIER_CACHE ?? "no"})`);
    const res = await runVerifier(diffs);
    verdicts = res.verdicts;
    console.log(`V2 done — ${res.calls} model calls, ${res.unparseable} abstained/unparseable (kept)`);
  }

  let verdicts25: V25Map | null = null;
  if (V25_MODEL) {
    console.log(`\nV2.5 verifier: ${V25_MODEL} (exclusion-first, scenario-gated, cached: ${V25_CACHE ?? "no"})`);
    const res = await runVerifier25(diffs);
    verdicts25 = res.verdicts;
    console.log(`V2.5 done — ${res.calls} model calls, ${res.unparseable} abstained/unparseable (kept)`);
  }

  let v3score: ((instanceId: string, f: Finding) => number | undefined) | null = null;
  if (V3_MODELS.length > 0) {
    console.log(`\nV3 verifier: ${V3_MODELS.join(" + ")} × ${V3_CRITERIA.length} criteria × K=${V3_K} (cached: ${V3_CACHE ?? "no"})`);
    const res = await runV3(diffs);
    v3score = res.score;
    console.log(`V3 done — ${res.calls} model calls this run`);
  }

  const judgedReal = (instanceId: string, c: Cluster): boolean =>
    verdicts?.[findingKey(instanceId, c.rep)] ?? true;
  // V2.5 keep: abstain (missing or sentinel conf -1) -> keep; else real AND conf >= t.
  const keep25 = (t: number) => (c: Cluster, instanceId: string): boolean => {
    const v = verdicts25?.[findingKey25(instanceId, c.rep)];
    if (!v || v.conf < 0) return true;
    return v.real && v.conf >= t;
  };
  const v3Keep = (tau: number) => (c: Cluster, instanceId: string): boolean => {
    const s = v3score?.(instanceId, c.rep);
    return s === undefined ? true : s >= tau; // abstain -> keep
  };

  const rows: Row[] = [];
  for (const arch of ARCHES) {
    rows.push(evaluateRow(`${arch} single mean`, runs.filter((r) => r.architecture === arch)));
    rows.push(evaluateRow(`  ${arch} V0 union`, pooledRuns(arch, "v0", () => true)));
    for (let k = 2; k <= maxN; k += 1) {
      rows.push(evaluateRow(`  ${arch} V1 k=${k}`, pooledRuns(arch, `v1k${k}`, (c) => c.runsWith.size >= k)));
    }
    if (verdicts) {
      rows.push(evaluateRow(`  ${arch} V2`, pooledRuns(arch, "v2", (c, id) => judgedReal(id, c))));
      rows.push(
        evaluateRow(
          `  ${arch} V1k2+V2`,
          pooledRuns(arch, "v1k2v2", (c, id) => c.runsWith.size >= 2 && judgedReal(id, c)),
        ),
      );
    }
    if (verdicts25) {
      for (const t of [6, 8]) {
        rows.push(evaluateRow(`  ${arch} V2.5 c≥${t}`, pooledRuns(arch, `v25c${t}`, (c, id) => keep25(t)(c, id))));
      }
      rows.push(
        evaluateRow(
          `  ${arch} V1k2+V2.5c8`,
          pooledRuns(arch, "v1k2v25", (c, id) => c.runsWith.size >= 2 && keep25(8)(c, id)),
        ),
      );
    }
    if (v3score) {
      for (const tau of [0.5, 0.6, 0.7]) {
        rows.push(evaluateRow(`  ${arch} V3 τ=${tau}`, pooledRuns(arch, `v3t${tau}`, (c, id) => v3Keep(tau)(c, id))));
      }
      rows.push(
        evaluateRow(
          `  ${arch} V1k2+V3τ.6`,
          pooledRuns(arch, "v1k2v3", (c, id) => c.runsWith.size >= 2 && v3Keep(0.6)(c, id)),
        ),
      );
    }
  }

  // Discrimination diagnostic — the test V2 failed. Does the continuous V3
  // score separate golden-matched from non-matched pooled findings?
  if (v3score) {
    const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
    const matched: number[] = [];
    const unmatched: number[] = [];
    for (const [, archPools] of pools) {
      for (const [instanceId, pool] of archPools) {
        const golden = pool.template.groundTruth;
        for (const c of pool.clusters) {
          const s = v3score(instanceId, c.rep);
          if (s === undefined) continue;
          const hits = golden.some(
            (g) => normPath(g.file) === normPath(c.rep.file) && c.rep.line >= g.lineStart && c.rep.line <= g.lineEnd,
          );
          (hits ? matched : unmatched).push(s);
        }
      }
    }
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
    // P(score_matched > score_unmatched) — a simple AUC over all pairs.
    let wins = 0;
    let ties = 0;
    for (const a of matched) for (const b of unmatched) { if (a > b) wins += 1; else if (a === b) ties += 1; }
    const auc = matched.length && unmatched.length ? (wins + ties / 2) / (matched.length * unmatched.length) : NaN;
    console.log(
      `\nV3 discrimination: mean score golden-matched ${mean(matched).toFixed(2)} (n=${matched.length}) vs ` +
        `non-matched ${mean(unmatched).toFixed(2)} (n=${unmatched.length}) — AUC ${auc.toFixed(2)} ` +
        `(V2's implicit AUC was ~0.5: flat 82% "real" everywhere)`,
    );
  }

  // V2.5 discrimination diagnostic — same test V2 failed (17% rejection, AUC
  // ~0.5) and V3 half-passed (AUC 0.68, no F1 gain). Abstentions excluded.
  if (verdicts25) {
    const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
    const matched: number[] = [];
    const unmatched: number[] = [];
    let rejected = 0;
    let judged = 0;
    for (const [, archPools] of pools) {
      for (const [instanceId, pool] of archPools) {
        const golden = pool.template.groundTruth;
        for (const c of pool.clusters) {
          const v = verdicts25[findingKey25(instanceId, c.rep)];
          if (!v || v.conf < 0) continue;
          judged += 1;
          if (!(v.real && v.conf >= 8)) rejected += 1;
          const hits = golden.some(
            (g) => normPath(g.file) === normPath(c.rep.file) && c.rep.line >= g.lineStart && c.rep.line <= g.lineEnd,
          );
          // Effective score: rejects rank below any approval, then by confidence.
          (hits ? matched : unmatched).push(v.real ? v.conf / 10 : -1 + v.conf / 100);
        }
      }
    }
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
    let wins = 0;
    let ties = 0;
    for (const a of matched) for (const b of unmatched) { if (a > b) wins += 1; else if (a === b) ties += 1; }
    const auc = matched.length && unmatched.length ? (wins + ties / 2) / (matched.length * unmatched.length) : NaN;
    console.log(
      `\nV2.5 discrimination: rejection rate ${judged ? ((rejected / judged) * 100).toFixed(0) : "–"}% at c≥8 ` +
        `(V2: 17%); mean eff-score golden-matched ${mean(matched).toFixed(2)} (n=${matched.length}) vs ` +
        `non-matched ${mean(unmatched).toFixed(2)} (n=${unmatched.length}) — AUC ${auc.toFixed(2)} ` +
        `(V2 ~0.5, V3 0.68)`,
    );
  }

  console.log(`\n=== VF-BoN vs the ladder — strict (file+line) vs semantic (judge τ=${TAU}) ===`);
  console.log("variant".padEnd(26) + "  n    findings/run   P(s)→P(sem)   R(s)→R(sem)   F1(s)→F1(sem)");
  for (const row of rows) {
    console.log(
      row.label.padEnd(26) +
        `  ${String(row.n).padEnd(3)}  ${row.avgFindings.toFixed(1).padStart(6)}        ` +
        `${row.strict.p.toFixed(2)}→${row.semantic.p.toFixed(2)}     ` +
        `${row.strict.r.toFixed(2)}→${row.semantic.r.toFixed(2)}     ` +
        `${row.strict.f1.toFixed(2)}→${row.semantic.f1.toFixed(2)}`,
    );
  }
  console.log(
    "\nExploratory replay (doc 08): NOT part of the registered confirmatory analysis.\n" +
      "V2 verdicts are per unique pooled finding; abstentions are kept, never filtered.",
  );

  if (process.env.BON_OUT) {
    writeFileSync(
      process.env.BON_OUT,
      JSON.stringify({ tau: TAU, runsIn, verifier: VERIFIER_MODEL ?? null, verifier25: V25_MODEL ?? null, rows }, null, 2),
    );
    console.log(`report → ${process.env.BON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
