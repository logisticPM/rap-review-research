# A2 — LLM-Judge Semantic Matcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM-judge semantic matcher (Approach A: async precompute → persisted score cache → sync matcher) so ground-truth matching becomes `file AND (line-overlap OR judge-score ≥ τ)`, without touching the synchronous evaluator.

**Architecture:** A judge prompt+parser, a serializable `SemanticScoreCache`, an async `JudgeScorePrecomputer` (calls a Bedrock non-Anthropic model via the existing `ILLMProvider`, only for same-file/non-overlapping pairs), and a sync `CachedSemanticMatcher implements ISemanticMatcher` that reads the cache. `IssueMatcher` gains a `semanticThreshold` and uses the score to rescue non-overlapping same-file matches.

**Tech Stack:** TypeScript (strict, native Node type-stripping), `node:test`. Node ≥ 22.18. Run single files with `node --test --experimental-strip-types <file>`; full check `npm run check`.

**Spec:** `docs/superpowers/specs/2026-07-08-a2-semantic-matcher-design.md`

---

## File structure

- **Create** `src/benchmark/matching/semantic-score-cache.ts` — `pairKey` + `SemanticScoreCache` (get/set/has/toJSON/fromJSON).
- **Create** `src/benchmark/matching/judge-prompt.ts` — `JudgeConfig`, `DEFAULT_JUDGE_CONFIG`, `buildJudgePrompt`, `parseJudgeScore`.
- **Create** `src/benchmark/matching/cached-semantic-matcher.ts` — `CachedSemanticMatcher implements ISemanticMatcher`.
- **Create** `src/benchmark/matching/judge-score-precomputer.ts` — `JudgeScorePrecomputer` (async).
- **Modify** `src/benchmark/matching/issue-matcher.ts` — add `semanticThreshold`, rescue rule.
- **Modify** `src/benchmark/index.ts` — export the new public symbols (once, Task 5).
- **Tests** — one `tests/unit/*.test.ts` per component; gating + integration in Task 5.

---

## Task 1: `SemanticScoreCache`

**Files:** Create `src/benchmark/matching/semantic-score-cache.ts`; Test `tests/unit/semantic-score-cache.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue } from "../../src/benchmark/index.ts";
import { SemanticScoreCache, pairKey } from "../../src/benchmark/matching/semantic-score-cache.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { id: "f", title: "t", category: "correctness", severity: "high", file: "a.ts", line: 11, description: "d", recommendation: "r", confidence: 0.8, ...overrides };
}
function issue(overrides: Partial<GroundTruthIssue> = {}): GroundTruthIssue {
  return { id: "g", file: "a.ts", lineStart: 10, lineEnd: 12, ...overrides };
}

test("get returns undefined before set, the score after", () => {
  const c = new SemanticScoreCache();
  assert.equal(c.get(finding(), issue()), undefined);
  assert.equal(c.has(finding(), issue()), false);
  c.set(finding(), issue(), 0.9);
  assert.equal(c.get(finding(), issue()), 0.9);
  assert.equal(c.has(finding(), issue()), true);
});

test("different pairs get different keys", () => {
  assert.notEqual(pairKey(finding(), issue()), pairKey(finding({ line: 50 }), issue()));
});

test("toJSON/fromJSON round-trips", () => {
  const c = new SemanticScoreCache();
  c.set(finding(), issue(), 0.5);
  const restored = SemanticScoreCache.fromJSON(c.toJSON());
  assert.equal(restored.get(finding(), issue()), 0.5);
});
```

- [ ] **Step 2: Run — verify it FAILS** (module not found): `node --test --experimental-strip-types tests/unit/semantic-score-cache.test.ts`

- [ ] **Step 3: Implement `src/benchmark/matching/semantic-score-cache.ts`**

```ts
import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";

/**
 * Stable, deterministic key for one (finding, issue) pair. LLM-free. Includes
 * the fields the judge actually sees, so a change to any of them is a cache miss.
 */
export function pairKey(finding: ReviewFinding, issue: GroundTruthIssue): string {
  return JSON.stringify([
    finding.file, finding.line, finding.title, finding.description,
    issue.file, issue.lineStart, issue.lineEnd, issue.title ?? "", issue.description ?? "",
  ]);
}

/**
 * A serializable store of judge scores keyed by pair identity (A2). Persisting
 * it makes semantic matching replayable at zero further judge cost.
 */
export class SemanticScoreCache {
  private readonly scores = new Map<string, number>();

  public get(finding: ReviewFinding, issue: GroundTruthIssue): number | undefined {
    return this.scores.get(pairKey(finding, issue));
  }
  public set(finding: ReviewFinding, issue: GroundTruthIssue, score: number): void {
    this.scores.set(pairKey(finding, issue), score);
  }
  public has(finding: ReviewFinding, issue: GroundTruthIssue): boolean {
    return this.scores.has(pairKey(finding, issue));
  }
  public toJSON(): Record<string, number> {
    return Object.fromEntries(this.scores);
  }
  public static fromJSON(data: Record<string, number>): SemanticScoreCache {
    const cache = new SemanticScoreCache();
    for (const [key, value] of Object.entries(data)) {
      cache.scores.set(key, value);
    }
    return cache;
  }
}
```

- [ ] **Step 4: Run — verify it PASSES** (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/chntw/Documents/7980/rap-review-research" add src/benchmark/matching/semantic-score-cache.ts tests/unit/semantic-score-cache.test.ts
git -C "C:/Users/chntw/Documents/7980/rap-review-research" commit -m "feat(benchmark): SemanticScoreCache for A2 judge scores"
```
(End every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.)

---

## Task 2: Judge prompt + parser

**Files:** Create `src/benchmark/matching/judge-prompt.ts`; Test `tests/unit/judge-prompt.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue } from "../../src/benchmark/index.ts";
import { buildJudgePrompt, parseJudgeScore, DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";

const finding: ReviewFinding = { id: "f", title: "SQL injection", category: "security", severity: "high", file: "db.ts", line: 11, description: "unsanitized input", recommendation: "sanitize", confidence: 0.8 };
const issue: GroundTruthIssue = { id: "g", file: "db.ts", lineStart: 10, lineEnd: 12, title: "SQLi", description: "injection risk" };

test("parseJudgeScore extracts, clamps, and rejects junk", () => {
  assert.equal(parseJudgeScore('{"score": 0.8}'), 0.8);
  assert.equal(parseJudgeScore('prefix {"score": 1.5} suffix'), 1);
  assert.equal(parseJudgeScore('{"score": -0.2}'), 0);
  assert.equal(parseJudgeScore("not json"), undefined);
  assert.equal(parseJudgeScore('{"other": 1}'), undefined);
});

test("buildJudgePrompt renders both items and applies config", () => {
  const req = buildJudgePrompt(finding, issue, { modelId: "m", temperature: 0, maxTokens: 64 });
  assert.equal(req.modelId, "m");
  assert.equal(req.temperature, 0);
  assert.equal(req.maxTokens, 64);
  assert.match(req.userPrompt, /Produced finding/);
  assert.match(req.userPrompt, /Ground-truth issue/);
  assert.match(req.userPrompt, /SQL injection/);
});

test("DEFAULT_JUDGE_CONFIG is temperature 0", () => {
  assert.equal(DEFAULT_JUDGE_CONFIG.temperature, 0);
});
```

- [ ] **Step 2: Run — verify it FAILS.**

- [ ] **Step 3: Implement `src/benchmark/matching/judge-prompt.ts`**

```ts
import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { LLMReviewRequest } from "../../llm/models/llm-review-request.ts";

/** Model + inference config for the semantic judge (A2). */
export interface JudgeConfig {
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

/**
 * Default judge: a Bedrock non-Anthropic model (different family than the Claude
 * systems under test). Confirm the id is enabled in the target region before the
 * pilot; override via `JudgeConfig`.
 */
export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  modelId: "us.meta.llama3-3-70b-instruct-v1:0",
  temperature: 0,
  maxTokens: 64,
};

const JUDGE_SYSTEM_PROMPT =
  "You are a strict evaluator for a code-review benchmark. You are given ONE " +
  "finding produced by an automated reviewer and ONE ground-truth issue. Decide " +
  "whether they describe THE SAME underlying problem at the same code location, " +
  "allowing for reworded descriptions and small line differences. Respond with " +
  'ONLY a JSON object {"score": n} where n is in [0,1]: 1 = certainly the same ' +
  "issue, 0 = certainly different. Output no other text.";

function renderFinding(f: ReviewFinding): string {
  return `file: ${f.file}\nline: ${f.line}\ntitle: ${f.title}\ndescription: ${f.description}`;
}
function renderIssue(i: GroundTruthIssue): string {
  return `file: ${i.file}\nlines: ${i.lineStart}-${i.lineEnd}\ntitle: ${i.title ?? "(none)"}\ndescription: ${i.description ?? "(none)"}`;
}

export function buildJudgePrompt(
  finding: ReviewFinding,
  issue: GroundTruthIssue,
  config: JudgeConfig,
): LLMReviewRequest {
  return {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt: `## Produced finding\n${renderFinding(finding)}\n\n## Ground-truth issue\n${renderIssue(issue)}`,
    modelId: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

/** Tolerant parse of a judge response into a score in [0,1], or undefined. */
export function parseJudgeScore(text: string): number | undefined {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end < start) {
      return undefined;
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const score = parsed.score;
    if (typeof score !== "number" || Number.isNaN(score)) {
      return undefined;
    }
    return Math.max(0, Math.min(1, score));
  } catch {
    return undefined;
  }
}
```

> Note: `LLMReviewRequest` fields are `systemPrompt, userPrompt, modelId, temperature, maxTokens` (all required) plus optional `jsonSchema` — verify against `src/llm/models/llm-review-request.ts` and match exactly.

- [ ] **Step 4: Run — verify it PASSES.**

- [ ] **Step 5: Commit** (`feat(benchmark): A2 judge prompt + score parser`).

---

## Task 3: `CachedSemanticMatcher`

**Files:** Create `src/benchmark/matching/cached-semantic-matcher.ts`; Test `tests/unit/cached-semantic-matcher.test.ts`. Depends on Task 1.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue } from "../../src/benchmark/index.ts";
import { SemanticScoreCache } from "../../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../../src/benchmark/matching/cached-semantic-matcher.ts";

const finding: ReviewFinding = { id: "f", title: "t", category: "c", severity: "high", file: "a.ts", line: 11, description: "d", recommendation: "r", confidence: 0.8 };
const issue: GroundTruthIssue = { id: "g", file: "a.ts", lineStart: 10, lineEnd: 12 };
const other: GroundTruthIssue = { id: "g2", file: "b.ts", lineStart: 1, lineEnd: 1 };

test("reads a cached score; misses return undefined (sync, no LLM)", () => {
  const cache = new SemanticScoreCache();
  cache.set(finding, issue, 0.8);
  const m = new CachedSemanticMatcher(cache);
  assert.equal(m.score(finding, issue), 0.8);
  assert.equal(m.score(finding, other), undefined);
});
```

- [ ] **Step 2: Run — verify it FAILS.**

- [ ] **Step 3: Implement `src/benchmark/matching/cached-semantic-matcher.ts`**

```ts
import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { ISemanticMatcher } from "./semantic-matcher.ts";
import type { SemanticScoreCache } from "./semantic-score-cache.ts";

/**
 * A synchronous {@link ISemanticMatcher} that reads precomputed judge scores
 * from a {@link SemanticScoreCache} (A2). Makes no LLM call — the async judging
 * happens once in {@link JudgeScorePrecomputer}, keeping the evaluator sync.
 */
export class CachedSemanticMatcher implements ISemanticMatcher {
  public constructor(private readonly cache: SemanticScoreCache) {}

  public score(finding: ReviewFinding, issue: GroundTruthIssue): number | undefined {
    return this.cache.get(finding, issue);
  }
}
```

- [ ] **Step 4: Run — verify it PASSES.**

- [ ] **Step 5: Commit** (`feat(benchmark): sync CachedSemanticMatcher reading the score cache`).

---

## Task 4: `JudgeScorePrecomputer`

**Files:** Create `src/benchmark/matching/judge-score-precomputer.ts`; Test `tests/unit/judge-score-precomputer.test.ts`. Depends on Tasks 1–2.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { BenchmarkRun, GroundTruthIssue } from "../../src/benchmark/index.ts";
import { SemanticScoreCache } from "../../src/benchmark/matching/semantic-score-cache.ts";
import { JudgeScorePrecomputer } from "../../src/benchmark/matching/judge-score-precomputer.ts";
import { DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";

function finding(file: string, line: number, title: string): ReviewFinding {
  return { id: `${file}:${line}`, title, category: "correctness", severity: "high", file, line, description: "d", recommendation: "r", confidence: 0.8 };
}
function run(producedFindings: ReviewFinding[], groundTruth: GroundTruthIssue[]): BenchmarkRun {
  return { runId: "r", datasetId: "ds", instanceId: "i", snapshotId: "s", experimentId: "e", architecture: "agentless", producedFindings, groundTruth };
}
const gt: GroundTruthIssue = { id: "g1", file: "a.ts", lineStart: 10, lineEnd: 12 };

test("judges only same-file, non-overlapping pairs and caches the score", async () => {
  let calls = 0;
  const provider = new MockProvider({ onReview: () => { calls += 1; }, responder: () => ({ text: '{"score": 0.9}' }) });
  const cache = new SemanticScoreCache();
  const r = run(
    [
      finding("a.ts", 99, "X"),  // same file, no overlap → candidate
      finding("b.ts", 1, "Y"),   // different file → skip
      finding("a.ts", 11, "Z"),  // overlaps [10,12] → skip
    ],
    [gt],
  );
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  assert.equal(calls, 1);
  assert.equal(cache.get(finding("a.ts", 99, "X"), gt), 0.9);
});

test("skips already-cached pairs (no duplicate judging)", async () => {
  let calls = 0;
  const provider = new MockProvider({ onReview: () => { calls += 1; }, responder: () => ({ text: '{"score": 0.9}' }) });
  const cache = new SemanticScoreCache();
  const r = run([finding("a.ts", 99, "X")], [gt]);
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  assert.equal(calls, 1);
});

test("parse failure leaves no cache entry", async () => {
  const provider = new MockProvider({ responder: () => ({ text: "garbage" }) });
  const cache = new SemanticScoreCache();
  const r = run([finding("a.ts", 99, "X")], [gt]);
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  assert.equal(cache.has(finding("a.ts", 99, "X"), gt), false);
});
```

- [ ] **Step 2: Run — verify it FAILS.**

- [ ] **Step 3: Implement `src/benchmark/matching/judge-score-precomputer.ts`**

```ts
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { BenchmarkRun } from "../models/benchmark-run.ts";
import type { JudgeConfig } from "./judge-prompt.ts";
import type { SemanticScoreCache } from "./semantic-score-cache.ts";

import { buildJudgePrompt, parseJudgeScore } from "./judge-prompt.ts";

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

/**
 * A pair is worth judging only when the finding is in the ground-truth issue's
 * file but does NOT overlap its line span — the only case where a semantic score
 * can change `matched` (overlap already matches; a different file never matches).
 */
function isCandidatePair(finding: ReviewFinding, issue: GroundTruthIssue): boolean {
  const fileMatch = normalizePath(finding.file) === normalizePath(issue.file);
  const lineOverlap = finding.line >= issue.lineStart && finding.line <= issue.lineEnd;
  return fileMatch && !lineOverlap;
}

/**
 * Async pre-pass (A2): fills a {@link SemanticScoreCache} with judge scores for
 * candidate pairs, so the synchronous evaluator can read them later. Judges each
 * uncached candidate pair exactly once. Deterministic given the provider.
 */
export class JudgeScorePrecomputer {
  public constructor(
    private readonly provider: ILLMProvider,
    private readonly config: JudgeConfig,
  ) {}

  public async precompute(
    runs: BenchmarkRun[],
    cache: SemanticScoreCache,
  ): Promise<void> {
    for (const run of runs) {
      for (const finding of run.producedFindings) {
        for (const issue of run.groundTruth) {
          if (!isCandidatePair(finding, issue) || cache.has(finding, issue)) {
            continue;
          }
          const response = await this.provider.review(
            buildJudgePrompt(finding, issue, this.config),
          );
          const score = parseJudgeScore(response.text);
          if (score !== undefined) {
            cache.set(finding, issue, score);
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run — verify it PASSES** (3 tests).

- [ ] **Step 5: Commit** (`feat(benchmark): JudgeScorePrecomputer (async, candidate-pair-only)`).

---

## Task 5: `IssueMatcher` gating + barrel exports + integration

**Files:** Modify `src/benchmark/matching/issue-matcher.ts`, `src/benchmark/index.ts`; Test add to `tests/unit/benchmark-matching.test.ts` and `tests/unit/benchmark-evaluator.test.ts`.

- [ ] **Step 1: Write the failing gating tests** — append to `tests/unit/benchmark-matching.test.ts`:

```ts
import type { ISemanticMatcher } from "../../src/benchmark/index.ts";

test("a semantic score >= threshold rescues a same-file, non-overlapping match", () => {
  const stub: ISemanticMatcher = { score: () => 0.9 };
  const m = new IssueMatcher({ semanticMatcher: stub, semanticThreshold: 0.7 });
  const result = m.match(finding({ line: 50 }), gt()); // 50 not in [10,12]
  assert.equal(result.lineOverlap, false);
  assert.equal(result.semanticScore, 0.9);
  assert.equal(result.matched, true);
});

test("a semantic score below threshold does not rescue", () => {
  const stub: ISemanticMatcher = { score: () => 0.5 };
  const m = new IssueMatcher({ semanticMatcher: stub, semanticThreshold: 0.7 });
  assert.equal(m.match(finding({ line: 50 }), gt()).matched, false);
});

test("default (Noop) matcher leaves line-based matching unchanged", () => {
  const m = new IssueMatcher();
  assert.equal(m.match(finding({ line: 50 }), gt()).matched, false);
  assert.equal(m.match(finding({ line: 11 }), gt()).matched, true);
});

test("semantic rescue does not override a different-file mismatch", () => {
  const stub: ISemanticMatcher = { score: () => 1 };
  const m = new IssueMatcher({ semanticMatcher: stub });
  assert.equal(m.match(finding({ file: "other.ts", line: 11 }), gt()).matched, false);
});
```

- [ ] **Step 2: Run — verify the new tests FAIL** (`semanticThreshold` not honored / rescue not implemented).

- [ ] **Step 3: Modify `src/benchmark/matching/issue-matcher.ts`**

Add to `IssueMatcherOptions`:

```ts
  /**
   * Minimum semantic score to rescue a same-file finding whose line does NOT
   * overlap the issue span (A2). Default 0.7. Ignored when the semantic matcher
   * returns undefined for the pair.
   */
  readonly semanticThreshold?: number;
```

Add the field + default in the class:

```ts
  private readonly semanticThreshold: number;
```
```ts
    this.semanticThreshold = options.semanticThreshold ?? 0.7;
```

Replace the matched-computation block:

```ts
    const semanticScore = this.semanticMatcher.score(finding, issue);
    const semanticPass =
      semanticScore !== undefined && semanticScore >= this.semanticThreshold;

    let matched = fileMatch;
    if (this.requireLineOverlap) {
      matched = matched && (lineOverlap || semanticPass);
    }
    if (this.requireCategoryMatch && categoryMatch !== undefined) {
      matched = matched && categoryMatch;
    }
    if (this.requireSeverityMatch && severityMatch !== undefined) {
      matched = matched && severityMatch;
    }
```

(The `return { matched, fileMatch, lineOverlap, categoryMatch, severityMatch, semanticScore }` block is unchanged.)

- [ ] **Step 4: Run — verify the gating tests PASS.**

- [ ] **Step 5: Add barrel exports** — in `src/benchmark/index.ts`, in the `// Matching.` section, after the existing `bipartite-matcher` export:

```ts
export type { JudgeConfig } from "./matching/judge-prompt.ts";
export {
  buildJudgePrompt,
  parseJudgeScore,
  DEFAULT_JUDGE_CONFIG,
} from "./matching/judge-prompt.ts";
export { pairKey, SemanticScoreCache } from "./matching/semantic-score-cache.ts";
export { CachedSemanticMatcher } from "./matching/cached-semantic-matcher.ts";
export { JudgeScorePrecomputer } from "./matching/judge-score-precomputer.ts";
```

- [ ] **Step 6: Write the failing integration test** — append to `tests/unit/benchmark-evaluator.test.ts`:

```ts
import { SemanticScoreCache } from "../../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../../src/benchmark/matching/cached-semantic-matcher.ts";
import { IssueMatcher } from "../../src/benchmark/index.ts";

test("semantic cache rescues a wrong-line finding, raising recall (A2)", () => {
  const gt: GroundTruthIssue[] = [{ id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 12 }];
  const wrongLine = finding("src/a.ts", 99); // right file, wrong line

  const strict = new GroundTruthEvaluator().evaluate(run([wrongLine], gt));
  assert.equal(strict.recall, 0); // strict: no match

  const cache = new SemanticScoreCache();
  cache.set(wrongLine, gt[0]!, 0.9);
  const semantic = new GroundTruthEvaluator({
    matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: 0.7 }),
  }).evaluate(run([wrongLine], gt));
  assert.equal(semantic.recall, 1); // rescued by the judge score
});
```

(The `finding(file, line)` and `run(...)` helpers already exist in this file.)

- [ ] **Step 7: Run — verify it FAILS, then (it should already pass given Step 3) confirm it PASSES.** If it fails, the gating change is incomplete — fix Step 3.

- [ ] **Step 8: Run the full check** — `npm run check` — tsc --strict clean; all tests pass (previous count + new).

- [ ] **Step 9: Commit** (`feat(benchmark): semantic-rescue gating in IssueMatcher + A2 barrel exports`).

---

## Self-review

- **Spec coverage:** judge prompt+parser (T2 ✔), `SemanticScoreCache` + persistence (T1 ✔), `JudgeScorePrecomputer` candidate-pair-only + skip-cached + parse-fail (T4 ✔), `CachedSemanticMatcher` sync (T3 ✔), `IssueMatcher` gating `file AND (line OR score≥τ)` + backward-compat (T5 ✔), barrel exports (T5 ✔), integration recall-rescue (T5 ✔). Deferred items (calibration harness, τ tuning, campaign wiring) are correctly **out of scope** and not tasked.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `JudgeConfig`/`DEFAULT_JUDGE_CONFIG` (T2) used by T4; `SemanticScoreCache.get/set/has/toJSON/fromJSON` (T1) used by T3/T4; `pairKey` (T1); `CachedSemanticMatcher` (T3) used in T5 integration; `ISemanticMatcher.score` signature matches; `IssueMatcher` option `semanticThreshold` (T5) matches its use. `LLMReviewRequest` field set flagged for verification in T2.
