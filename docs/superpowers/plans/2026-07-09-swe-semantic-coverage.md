# SWE-PRBench Semantic Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score the four review arms against Martian SWE-PRBench golden comments (location-less human review comments) via semantic LLM-judge matching → coverage/precision, mirroring Martian's own methodology.

**Architecture:** A dedicated SWE-coverage path that reuses the A2 judge and A4 dedup but introduces location-less types. The Qodo file+line path (`GroundTruthIssue`, `GroundTruthEvaluator`, `IssueMatcher`) and the old `SWEPRBenchAdapter` are NOT touched. New: golden-comment types + adapter, a coverage judge prompt/cache/precomputer, a `SemanticCoverageEvaluator`, and a `swe:eval` script.

**Tech Stack:** TypeScript on Node ≥22 (native type-stripping — NO parameter properties; use explicit fields + assignment). Tests via `node:test` + `node:assert/strict`. Zod for schemas (already a dep). Run one test file: `node --test tests/unit/<file>.test.ts`. Full check: `npm run check`.

**Spec:** `docs/superpowers/specs/2026-07-09-swe-semantic-coverage-design.md`.

---

### Task 1: Golden-comment types + SWE-coverage adapter

**Files:**
- Create: `src/benchmark/models/golden-comment.ts`
- Create: `src/benchmark/models/swe-coverage-dataset.ts`
- Create: `src/benchmark/adapters/swe-golden-adapter.ts`
- Test: `tests/unit/swe-golden-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/swe-golden-adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SweGoldenAdapter } from "../../src/benchmark/adapters/swe-golden-adapter.ts";
import { DatasetAdapterError } from "../../src/benchmark/benchmark-errors.ts";

const RAW = {
  name: "SWE-PRBench (sample)",
  instances: [
    {
      instance_id: "grafana-79265",
      pr_title: "Add configurable device limit",
      patch: "diff --git a/x.go b/x.go\n@@ -1 +1 @@\n-a\n+b\n",
      golden_comments: [
        { comment: "Race condition on device count check.", severity: "High" },
        { comment: "Misleading error when no rows updated.", severity: "Low" },
      ],
    },
  ],
};

test("maps location-less golden comments into a coverage dataset", () => {
  const ds = new SweGoldenAdapter().toDataset(RAW);
  assert.equal(ds.source, "swe-prbench");
  assert.equal(ds.instances.length, 1);
  const inst = ds.instances[0];
  assert.equal(inst.instanceId, "grafana-79265");
  assert.equal(inst.rawDiff, RAW.instances[0].patch);
  assert.equal(inst.goldenComments.length, 2);
  assert.equal(inst.goldenComments[0].body, "Race condition on device count check.");
  assert.equal(inst.goldenComments[0].severity, "high"); // normalized
  assert.equal(inst.goldenComments[0].id, "grafana-79265-gc-0");
});

test("throws only on a missing instances array, id, or patch — never on missing location", () => {
  assert.throws(() => new SweGoldenAdapter().toDataset({} as never), DatasetAdapterError);
  assert.throws(
    () => new SweGoldenAdapter().toDataset({ instances: [{ pr_title: "x", patch: "d" }] } as never),
    DatasetAdapterError,
  );
  assert.throws(
    () => new SweGoldenAdapter().toDataset({ instances: [{ instance_id: "i" }] } as never),
    DatasetAdapterError,
  );
  // A comment with no file/line is fine (there is no location in this benchmark).
  const ds = new SweGoldenAdapter().toDataset({
    instances: [{ instance_id: "i", patch: "d", golden_comments: [{ comment: "c" }] }],
  } as never);
  assert.equal(ds.instances[0].goldenComments[0].severity, undefined);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/swe-golden-adapter.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the types**

```typescript
// src/benchmark/models/golden-comment.ts
import type { SeverityLevel } from "../../models/finding.ts";

/**
 * One human review comment from SWE-PRBench (Martian). Location-less: the
 * benchmark's golden comments are PR-level free text with a severity label and
 * NO file/line. Matched semantically (see SemanticCoverageEvaluator), never by
 * location.
 */
export interface GoldenComment {
  readonly id: string;
  readonly body: string;
  readonly severity?: SeverityLevel;
}
```

```typescript
// src/benchmark/models/swe-coverage-dataset.ts
import type { GoldenComment } from "./golden-comment.ts";

/** One SWE-PRBench PR: the diff under review + its location-less golden comments. */
export interface SweCoverageInstance {
  readonly instanceId: string;
  readonly title: string;
  readonly rawDiff: string;
  readonly goldenComments: GoldenComment[];
}

export interface SweCoverageDataset {
  readonly name: string;
  readonly source: "swe-prbench";
  readonly instances: SweCoverageInstance[];
}
```

- [ ] **Step 4: Create the adapter**

```typescript
// src/benchmark/adapters/swe-golden-adapter.ts
import type { GoldenComment } from "../models/golden-comment.ts";
import type {
  SweCoverageDataset,
  SweCoverageInstance,
} from "../models/swe-coverage-dataset.ts";
import { normalizeSeverity } from "./normalize-severity.ts";
import { firstDefined, toStringField } from "./raw-field.ts";
import { DatasetAdapterError } from "../benchmark-errors.ts";

/**
 * Raw Martian golden-comment shapes (tolerant aliases). Golden comments carry no
 * file/line — matching is semantic (SemanticCoverageEvaluator). Confirm the
 * schema against withmartian/code-review-benchmark `offline/golden_comments/`.
 */
export interface SweGoldenRawComment {
  readonly comment?: string;
  readonly body?: string;
  readonly text?: string;
  readonly severity?: string;
}
export interface SweGoldenRawInstance {
  readonly instance_id?: string;
  readonly id?: string;
  readonly url?: string;
  readonly pr_title?: string;
  readonly title?: string;
  readonly patch?: string;
  readonly diff?: string;
  readonly golden_comments?: SweGoldenRawComment[];
  readonly comments?: SweGoldenRawComment[];
}
export interface SweGoldenRawDataset {
  readonly name?: string;
  readonly instances?: SweGoldenRawInstance[];
  readonly rows?: SweGoldenRawInstance[];
  readonly data?: SweGoldenRawInstance[];
}

/** Maps Martian golden-comment rows into a {@link SweCoverageDataset}. */
export class SweGoldenAdapter {
  public toDataset(raw: SweGoldenRawDataset): SweCoverageDataset {
    const instances = firstDefined(raw?.instances, raw?.rows, raw?.data);
    if (!Array.isArray(instances)) {
      throw new DatasetAdapterError(
        "SWE golden dataset is missing an instances array (`instances` | `rows` | `data`).",
      );
    }
    return {
      name: raw.name ?? "SWE-PRBench",
      source: "swe-prbench",
      instances: instances.map((row) => this.toInstance(row)),
    };
  }

  private toInstance(row: SweGoldenRawInstance): SweCoverageInstance {
    const id = firstDefined(row.instance_id, row.id, row.url);
    const patch = firstDefined(row.patch, row.diff);
    if (!id || typeof patch !== "string") {
      throw new DatasetAdapterError(
        `SWE golden row is missing an instance_id/url or patch (id="${id ?? ""}").`,
      );
    }
    const rawComments = firstDefined(row.golden_comments, row.comments) ?? [];
    return {
      instanceId: id,
      title: firstDefined(row.pr_title, row.title) ?? id,
      rawDiff: patch,
      goldenComments: rawComments.map((c, index) => this.toComment(id, c, index)),
    };
  }

  private toComment(
    instanceId: string,
    raw: SweGoldenRawComment,
    index: number,
  ): GoldenComment {
    const body = toStringField(firstDefined(raw.comment, raw.body, raw.text)) ?? "";
    return {
      id: `${instanceId}-gc-${index}`,
      body,
      severity: normalizeSeverity(raw.severity),
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/unit/swe-golden-adapter.test.ts`
Expected: PASS (both tests).

> Note: `firstDefined` / `toStringField` live in `src/benchmark/adapters/raw-field.ts` (used by the Qodo adapter). `normalizeSeverity` returns `SeverityLevel | undefined`. Confirm both imports resolve; do not re-implement them.

- [ ] **Step 6: Commit**

```bash
git add src/benchmark/models/golden-comment.ts src/benchmark/models/swe-coverage-dataset.ts src/benchmark/adapters/swe-golden-adapter.ts tests/unit/swe-golden-adapter.test.ts
git commit -m "feat(swe): golden-comment types + location-less SWE adapter"
```

---

### Task 2: `dedupeFindings` helper (shared)

**Files:**
- Modify: `src/architectures/shared/finding-dedup.ts` (append a helper; do not change `areDuplicateFindings`)
- Test: `tests/unit/finding-dedup.test.ts` (append) — if the file does not exist, create it with the test below.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/unit/finding-dedup.test.ts (create the file with these imports if absent)
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeFindings } from "../../src/architectures/shared/finding-dedup.ts";

test("dedupeFindings collapses near-duplicate findings (same file, ±2 lines, similar title)", () => {
  const findings = [
    { file: "a.ts", line: 10, title: "SQL injection risk" },
    { file: "a.ts", line: 11, title: "SQL injection risk" }, // dup of the first
    { file: "b.ts", line: 3, title: "Unvalidated input" },
  ];
  const unique = dedupeFindings(findings);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].file, "a.ts");
  assert.equal(unique[1].file, "b.ts");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/finding-dedup.test.ts`
Expected: FAIL (`dedupeFindings` not exported).

- [ ] **Step 3: Append the helper to `finding-dedup.ts`**

```typescript
/**
 * Collapse a list to its unique findings under {@link areDuplicateFindings}: a
 * finding is kept unless it duplicates one already kept. Order-stable. Used by
 * the SWE coverage path (and available anywhere unique findings are needed).
 */
export function dedupeFindings<T extends FindingLocus>(
  findings: readonly T[],
  options: FindingDedupOptions = {},
): T[] {
  const unique: T[] = [];
  for (const finding of findings) {
    if (!unique.some((kept) => areDuplicateFindings(kept, finding, options))) {
      unique.push(finding);
    }
  }
  return unique;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/finding-dedup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/architectures/shared/finding-dedup.ts tests/unit/finding-dedup.test.ts
git commit -m "feat(dedup): add dedupeFindings list helper over areDuplicateFindings"
```

---

### Task 3: `CoverageScoreCache`

**Files:**
- Create: `src/benchmark/matching/coverage-score-cache.ts`
- Test: `tests/unit/coverage-score-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/coverage-score-cache.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageScoreCache, coveragePairKey } from "../../src/benchmark/matching/coverage-score-cache.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";

const FINDING: ReviewFinding = {
  id: "f1", title: "SQL injection", category: "security", severity: "high",
  file: "a.ts", line: 10, description: "user input concatenated", recommendation: "parameterize", confidence: 0.9,
};
const COMMENT: GoldenComment = { id: "i-gc-0", body: "SQL injection via string concat", severity: "high" };

test("set/get/has round-trip and JSON persistence", () => {
  const cache = new CoverageScoreCache();
  assert.equal(cache.has(FINDING, COMMENT), false);
  cache.set(FINDING, COMMENT, 1);
  assert.equal(cache.get(FINDING, COMMENT), 1);
  const revived = CoverageScoreCache.fromJSON(cache.toJSON());
  assert.equal(revived.get(FINDING, COMMENT), 1);
});

test("pairKey ignores finding.line (A3 re-anchor seam)", () => {
  assert.equal(
    coveragePairKey({ ...FINDING, line: 10 }, COMMENT),
    coveragePairKey({ ...FINDING, line: 999 }, COMMENT),
  );
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/coverage-score-cache.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement (mirrors SemanticScoreCache)**

```typescript
// src/benchmark/matching/coverage-score-cache.ts
import type { ReviewFinding } from "../../models/finding.ts";
import type { GoldenComment } from "../models/golden-comment.ts";

/**
 * Stable key for one (finding, golden-comment) pair. LLM-free. `finding.line` is
 * intentionally excluded (mirrors SemanticScoreCache: A3 re-anchors the line);
 * `comment.id` + `comment.body` identify the human comment (it has no location).
 */
export function coveragePairKey(finding: ReviewFinding, comment: GoldenComment): string {
  return JSON.stringify([finding.file, finding.title, finding.description, comment.id, comment.body]);
}

/** Serializable store of coverage-judge scores, keyed by pair identity. */
export class CoverageScoreCache {
  private readonly scores = new Map<string, number>();

  public get(finding: ReviewFinding, comment: GoldenComment): number | undefined {
    return this.scores.get(coveragePairKey(finding, comment));
  }
  public set(finding: ReviewFinding, comment: GoldenComment, score: number): void {
    this.scores.set(coveragePairKey(finding, comment), score);
  }
  public has(finding: ReviewFinding, comment: GoldenComment): boolean {
    return this.scores.has(coveragePairKey(finding, comment));
  }
  public toJSON(): Record<string, number> {
    return Object.fromEntries(this.scores);
  }
  public static fromJSON(data: Record<string, number>): CoverageScoreCache {
    const cache = new CoverageScoreCache();
    for (const [key, value] of Object.entries(data)) {
      cache.scores.set(key, value);
    }
    return cache;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/coverage-score-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/matching/coverage-score-cache.ts tests/unit/coverage-score-cache.test.ts
git commit -m "feat(swe): CoverageScoreCache keyed by (finding, golden-comment)"
```

---

### Task 4: Coverage judge prompt

**Files:**
- Modify: `src/benchmark/matching/judge-prompt.ts` (append `buildCoverageJudgePrompt`; reuse the private `renderFinding` and `parseJudgeScore`)
- Test: `tests/unit/coverage-judge-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/coverage-judge-prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverageJudgePrompt, DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";

const FINDING: ReviewFinding = {
  id: "f1", title: "SQL injection", category: "security", severity: "high",
  file: "a.ts", line: 10, description: "user input concatenated", recommendation: "parameterize", confidence: 0.9,
};
const COMMENT: GoldenComment = { id: "i-gc-0", body: "SQL injection via string concat", severity: "high" };

test("renders finding + human comment, no location for the comment", () => {
  const req = buildCoverageJudgePrompt(FINDING, COMMENT, DEFAULT_JUDGE_CONFIG);
  assert.match(req.userPrompt, /SQL injection/);           // finding
  assert.match(req.userPrompt, /SQL injection via string concat/); // comment body
  assert.match(req.userPrompt, /human review comment/i);
  assert.doesNotMatch(req.userPrompt.split("human review comment")[1] ?? "", /line:/); // comment block has no line
  assert.equal(req.modelId, DEFAULT_JUDGE_CONFIG.modelId);
  assert.equal(req.maxTokens, DEFAULT_JUDGE_CONFIG.maxTokens);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/coverage-judge-prompt.test.ts`
Expected: FAIL (`buildCoverageJudgePrompt` not exported).

- [ ] **Step 3: Append to `judge-prompt.ts`**

Add the import at the top (next to the existing type imports):

```typescript
import type { GoldenComment } from "../models/golden-comment.ts";
```

Append at the end of the file (reuses the existing private `renderFinding`):

```typescript
const COVERAGE_SYSTEM_PROMPT =
  "You are a strict evaluator for a code-review benchmark. You are given ONE " +
  "finding produced by an automated reviewer and ONE human review comment. The " +
  "human comment has no line number. Decide whether they describe THE SAME " +
  "underlying issue, allowing for reworded descriptions. Respond with ONLY a " +
  'JSON object {"score": n} where n is in [0,1]: 1 = certainly the same issue, ' +
  "0 = certainly different. Output no other text.";

function renderComment(c: GoldenComment): string {
  return `severity: ${c.severity ?? "(none)"}\ncomment: ${c.body}`;
}

/**
 * Judge prompt for SWE coverage: is the produced finding the same underlying
 * issue as this (location-less) human review comment? Reuses {@link parseJudgeScore}.
 */
export function buildCoverageJudgePrompt(
  finding: ReviewFinding,
  comment: GoldenComment,
  config: JudgeConfig,
): LLMReviewRequest {
  return {
    systemPrompt: COVERAGE_SYSTEM_PROMPT,
    userPrompt: `## Produced finding\n${renderFinding(finding)}\n\n## Human review comment\n${renderComment(comment)}`,
    modelId: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/coverage-judge-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/matching/judge-prompt.ts tests/unit/coverage-judge-prompt.test.ts
git commit -m "feat(swe): coverage judge prompt (finding vs location-less human comment)"
```

---

### Task 5: `CoverageJudgePrecomputer`

**Files:**
- Create: `src/benchmark/matching/coverage-judge-precomputer.ts`
- Test: `tests/unit/coverage-judge-precomputer.test.ts`

**Context:** `BenchmarkRun` (`src/benchmark/models/benchmark-run.ts`) has `instanceId` and `producedFindings: ReviewFinding[]`. `ILLMProvider.review(req)` returns `{ text, ... }` (see `src/llm/provider/llm-provider.ts`). `MockProvider` (`src/llm/provider/mock-provider.ts`) takes `{ responder }` where `responder(req) => { text }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/coverage-judge-precomputer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageJudgePrecomputer } from "../../src/benchmark/matching/coverage-judge-precomputer.ts";
import { CoverageScoreCache } from "../../src/benchmark/matching/coverage-score-cache.ts";
import { DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";
import type { BenchmarkRun } from "../../src/benchmark/models/benchmark-run.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";

function finding(id: string, title: string): ReviewFinding {
  return { id, title, category: "security", severity: "high", file: "a.ts", line: 1, description: title, recommendation: "fix", confidence: 0.9 };
}
const run: BenchmarkRun = {
  runId: "r", datasetId: "swe-prbench", instanceId: "i", snapshotId: "s", experimentId: "e",
  architecture: "agentless", producedFindings: [finding("f1", "SQL injection"), finding("f1b", "SQL injection")], groundTruth: [],
};
const comments = new Map<string, GoldenComment[]>([["i", [{ id: "i-gc-0", body: "sql injection" }]]]);

test("judges each unique (finding, comment) pair once and skips cached", async () => {
  let calls = 0;
  const provider = new MockProvider({ responder: () => { calls += 1; return { text: '{"score":1}' }; } });
  const cache = new CoverageScoreCache();
  const pre = new CoverageJudgePrecomputer(provider, DEFAULT_JUDGE_CONFIG);
  await pre.precompute([run], comments, cache);
  // f1 and f1b are duplicates (same file/line/title) → 1 unique finding × 1 comment = 1 call.
  assert.equal(calls, 1);
  await pre.precompute([run], comments, cache); // all cached now
  assert.equal(calls, 1);
});

test("a parse failure leaves no cache entry", async () => {
  const provider = new MockProvider({ responder: () => ({ text: "not json" }) });
  const cache = new CoverageScoreCache();
  await new CoverageJudgePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([run], comments, cache);
  assert.deepEqual(cache.toJSON(), {});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/coverage-judge-precomputer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/benchmark/matching/coverage-judge-precomputer.ts
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { BenchmarkRun } from "../models/benchmark-run.ts";
import type { GoldenComment } from "../models/golden-comment.ts";
import type { JudgeConfig } from "./judge-prompt.ts";
import type { CoverageScoreCache } from "./coverage-score-cache.ts";

import { buildCoverageJudgePrompt, parseJudgeScore } from "./judge-prompt.ts";
import { dedupeFindings } from "../../architectures/shared/finding-dedup.ts";

/**
 * Async pre-pass (SWE coverage): fills a {@link CoverageScoreCache} with judge
 * scores for every (unique finding × golden comment) pair, so the synchronous
 * evaluator can read them later. No location filter — golden comments have no
 * location. Sequential and resumable (skips cached pairs); the caller wraps this
 * in retry-with-backoff on rate limits (see scripts/benchmark-swe-eval.ts).
 */
export class CoverageJudgePrecomputer {
  private readonly provider: ILLMProvider;
  private readonly config: JudgeConfig;

  public constructor(provider: ILLMProvider, config: JudgeConfig) {
    this.provider = provider;
    this.config = config;
  }

  public async precompute(
    runs: BenchmarkRun[],
    commentsByInstance: Map<string, GoldenComment[]>,
    cache: CoverageScoreCache,
  ): Promise<void> {
    for (const run of runs) {
      const comments = commentsByInstance.get(run.instanceId) ?? [];
      const uniqueFindings = dedupeFindings(run.producedFindings);
      for (const finding of uniqueFindings) {
        for (const comment of comments) {
          if (cache.has(finding, comment)) {
            continue;
          }
          const response = await this.provider.review(
            buildCoverageJudgePrompt(finding, comment, this.config),
          );
          const score = parseJudgeScore(response.text);
          if (score !== undefined) {
            cache.set(finding, comment, score);
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/coverage-judge-precomputer.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/matching/coverage-judge-precomputer.ts tests/unit/coverage-judge-precomputer.test.ts
git commit -m "feat(swe): CoverageJudgePrecomputer (unique finding × golden comment)"
```

---

### Task 6: `SemanticCoverageEvaluator`

**Files:**
- Create: `src/benchmark/semantic-coverage-evaluator.ts`
- Test: `tests/unit/semantic-coverage-evaluator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/semantic-coverage-evaluator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SemanticCoverageEvaluator } from "../../src/benchmark/semantic-coverage-evaluator.ts";
import { CoverageScoreCache } from "../../src/benchmark/matching/coverage-score-cache.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";

function finding(id: string, title: string): ReviewFinding {
  return { id, title, category: "security", severity: "high", file: "a.ts", line: 1, description: title, recommendation: "fix", confidence: 0.9 };
}
const comments: GoldenComment[] = [
  { id: "c0", body: "sql injection", severity: "high" },
  { id: "c1", body: "missing null check", severity: "low" },
];

test("coverage, precision, f1, and by-severity from a populated cache", () => {
  const f1 = finding("f1", "SQL injection");
  const f2 = finding("f2", "noise finding"); // matches nothing
  const cache = new CoverageScoreCache();
  cache.set(f1, comments[0], 1); // f1 covers the high-severity comment
  const result = new SemanticCoverageEvaluator().evaluate([f1, f2], comments, cache);
  assert.equal(result.commentCount, 2);
  assert.equal(result.uniqueFindingCount, 2);
  assert.equal(result.matchedComments, 1);   // only c0 covered
  assert.equal(result.matchedFindings, 1);   // only f1 matched
  assert.equal(result.coverage, 0.5);        // 1/2
  assert.equal(result.precision, 0.5);       // 1/2
  assert.equal(result.coverageBySeverity.high, 1);  // 1/1 high covered
  assert.equal(result.coverageBySeverity.low, 0);   // 0/1 low covered
});

test("duplicate findings are collapsed before scoring precision", () => {
  const f1 = finding("f1", "SQL injection");
  const f1dup = finding("f1b", "SQL injection"); // A4 duplicate of f1
  const cache = new CoverageScoreCache();
  cache.set(f1, comments[0], 1);
  const result = new SemanticCoverageEvaluator().evaluate([f1, f1dup], comments, cache);
  assert.equal(result.uniqueFindingCount, 1); // collapsed
  assert.equal(result.precision, 1);          // 1 matched / 1 unique
});

test("zero denominators yield zero, not NaN", () => {
  const result = new SemanticCoverageEvaluator().evaluate([], [], new CoverageScoreCache());
  assert.equal(result.coverage, 0);
  assert.equal(result.precision, 0);
  assert.equal(result.f1, 0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/semantic-coverage-evaluator.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/benchmark/semantic-coverage-evaluator.ts
import type { ReviewFinding } from "../models/finding.ts";
import type { GoldenComment } from "./models/golden-comment.ts";
import type { CoverageScoreCache } from "./matching/coverage-score-cache.ts";
import { dedupeFindings } from "../architectures/shared/finding-dedup.ts";

/** Coverage of one arm's findings against a PR's golden comments (SWE-PRBench). */
export interface SemanticCoverageResult {
  readonly commentCount: number;
  readonly uniqueFindingCount: number;
  readonly matchedComments: number;
  readonly matchedFindings: number;
  readonly coverage: number; // recall: fraction of golden comments covered
  readonly precision: number; // fraction of unique findings matching a comment
  readonly f1: number;
  readonly coverageBySeverity: Record<string, number>;
}

/**
 * Scores produced findings against location-less golden comments via a
 * precomputed judge cache (SWE-PRBench, Martian-faithful): a (finding, comment)
 * pair matches when its cached judge score ≥ threshold. Deterministic given the
 * cache. Mirrors Martian's precision/recall; unmatched findings are noise
 * (report the count separately as possibly-beyond-human — the caller does this).
 */
export class SemanticCoverageEvaluator {
  private readonly threshold: number;

  public constructor(threshold = 0.7) {
    this.threshold = threshold;
  }

  public evaluate(
    producedFindings: ReviewFinding[],
    goldenComments: GoldenComment[],
    cache: CoverageScoreCache,
  ): SemanticCoverageResult {
    const unique = dedupeFindings(producedFindings);
    const matches = (finding: ReviewFinding, comment: GoldenComment): boolean => {
      const score = cache.get(finding, comment);
      return score !== undefined && score >= this.threshold;
    };

    const matchedComments = goldenComments.filter((c) =>
      unique.some((f) => matches(f, c)),
    ).length;
    const matchedFindings = unique.filter((f) =>
      goldenComments.some((c) => matches(f, c)),
    ).length;

    const coverage = ratio(matchedComments, goldenComments.length);
    const precision = ratio(matchedFindings, unique.length);
    const f1 = coverage + precision === 0 ? 0 : (2 * coverage * precision) / (coverage + precision);

    const coverageBySeverity: Record<string, number> = {};
    for (const severity of new Set(goldenComments.map((c) => c.severity ?? "unspecified"))) {
      const inBucket = goldenComments.filter((c) => (c.severity ?? "unspecified") === severity);
      const covered = inBucket.filter((c) => unique.some((f) => matches(f, c))).length;
      coverageBySeverity[severity] = ratio(covered, inBucket.length);
    }

    return {
      commentCount: goldenComments.length,
      uniqueFindingCount: unique.length,
      matchedComments,
      matchedFindings,
      coverage,
      precision,
      f1,
      coverageBySeverity,
    };
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/semantic-coverage-evaluator.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/semantic-coverage-evaluator.ts tests/unit/semantic-coverage-evaluator.test.ts
git commit -m "feat(swe): SemanticCoverageEvaluator (coverage/precision/f1 + by-severity)"
```

---

### Task 7: `swe:eval` script + npm alias + tsconfig include

**Files:**
- Create: `scripts/benchmark-swe-eval.ts`
- Modify: `package.json` (add `"swe:eval"` after `"judge:eval"`)
- Modify: `tsconfig.json` (add `"scripts/benchmark-swe-eval.ts"` to `include`)

**Context:** Model this on `scripts/benchmark-judge-eval.ts` (same pipeline setup + rate-limit retry). `CampaignRunner` needs a `BenchmarkDataset` whose `BenchmarkInstance`s carry `source: "swe-prbench"`, `rawDiff`, and `groundTruth: []` (SWE has no located GT — its `benchmarkResult` is ignored). Golden comments are attached separately by `instanceId`. `report.outcomes[].benchmarkRun` gives `producedFindings` + `instanceId` + `architecture`.

- [ ] **Step 1: Create the script**

```typescript
// scripts/benchmark-swe-eval.ts
/**
 * SWE-PRBench semantic coverage (experiment E2) — generate the four arms on the
 * Martian golden-comment set, judge findings against location-less human
 * comments ("same underlying issue?"), and report coverage/precision/F1 per arm.
 *
 * Run with: `npm run swe:eval`   (Bedrock; smoke-test first: `npm run smoke:bedrock`)
 * Env: BENCHMARK_DATA_DIR (=data/benchmark, reads swe.json), BENCHMARK_LIMIT (=1),
 *      JUDGE_MODEL (=DEFAULT_JUDGE_CONFIG.modelId), SEMANTIC_THRESHOLD (=0.7),
 *      RUNS_OUT / CACHE_OUT (persist for replay).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPRImportService } from "../src/services/snapshot/index.ts";
import { createExperimentService } from "../src/services/experiment/index.ts";
import { InMemorySnapshotRepository } from "../src/repositories/in-memory/in-memory-snapshot-repository.ts";
import { InMemoryRawDiffStorage } from "../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { InMemoryArchitectureRegistry } from "../src/architectures/in-memory-architecture-registry.ts";
import { AgentlessArchitecture } from "../src/architectures/agentless/agentless-architecture.ts";
import { createGeneralistsArchitecture } from "../src/architectures/generalists/index.ts";
import { createHierarchicalArchitecture } from "../src/architectures/hierarchical/index.ts";
import { createConsensusArchitecture } from "../src/architectures/consensus/index.ts";
import { PromptBuilder } from "../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../src/llm/prompts/context-builder.ts";
import { BedrockProvider } from "../src/llm/provider/bedrock-provider.ts";
import { LLM_CONFIG } from "../src/config/llm.ts";
import { ProviderRateLimitError } from "../src/llm/errors.ts";

import { CampaignRunner, InMemoryManifestStore, ProgressReporter } from "../src/campaign/index.ts";
import type { BenchmarkDataset, BenchmarkInstance } from "../src/benchmark/index.ts";
import type { GoldenComment } from "../src/benchmark/models/golden-comment.ts";
import { SweGoldenAdapter } from "../src/benchmark/adapters/swe-golden-adapter.ts";
import { CoverageScoreCache } from "../src/benchmark/matching/coverage-score-cache.ts";
import { CoverageJudgePrecomputer } from "../src/benchmark/matching/coverage-judge-precomputer.ts";
import { DEFAULT_JUDGE_CONFIG } from "../src/benchmark/matching/judge-prompt.ts";
import { SemanticCoverageEvaluator, type SemanticCoverageResult } from "../src/benchmark/semantic-coverage-evaluator.ts";

if (LLM_CONFIG.provider !== "bedrock") {
  console.error("swe:eval needs the Bedrock provider (live). Unset LLM_PROVIDER=mock.");
  process.exit(1);
}

const DATA_DIR = resolve(process.env.BENCHMARK_DATA_DIR ?? "data/benchmark");
const LIMIT = Math.max(1, Number(process.env.BENCHMARK_LIMIT ?? 1));
const TAU = Number(process.env.SEMANTIC_THRESHOLD ?? 0.7);
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_CONFIG.modelId;

const swePath = resolve(DATA_DIR, "swe.json");
if (!existsSync(swePath)) {
  console.error(`No swe.json under ${DATA_DIR}. See data/benchmark/README.md.`);
  process.exit(1);
}
const sweDataset = new SweGoldenAdapter().toDataset(JSON.parse(readFileSync(swePath, "utf8")));
const instances = sweDataset.instances.slice(0, LIMIT);
const commentsByInstance = new Map<string, GoldenComment[]>(
  instances.map((i) => [i.instanceId, i.goldenComments]),
);

// BenchmarkDataset for generation: SWE has no located ground truth (empty).
const genDataset: BenchmarkDataset = {
  datasetId: "swe-prbench",
  name: sweDataset.name,
  source: "swe-prbench",
  instances: instances.map(
    (i): BenchmarkInstance => ({
      instanceId: i.instanceId,
      title: i.title,
      source: "swe-prbench",
      rawDiff: i.rawDiff,
      groundTruth: [],
    }),
  ),
};

const provider = new BedrockProvider();
const promptBuilder = new PromptBuilder({ loader: new PromptLoader(), contextBuilder: new ContextBuilder() });
const snapshots = new InMemorySnapshotRepository();
const rawDiffStorage = new InMemoryRawDiffStorage();
const registry = new InMemoryArchitectureRegistry();
registry.register(new AgentlessArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createHierarchicalArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createConsensusArchitecture({ provider, promptBuilder, rawDiffStorage }));
const importCtx = createPRImportService({ snapshots, rawDiffStorage });
const experimentCtx = createExperimentService({ snapshots, registry });
const runner = new CampaignRunner({
  importService: importCtx.service,
  experimentService: experimentCtx.service,
  storage: experimentCtx.storage,
  reporter: new ProgressReporter({ sink: (line) => console.log(line) }),
  manifestStore: new InMemoryManifestStore(),
});

console.log(`SWE coverage — model ${LLM_CONFIG.defaultModel} @ ${LLM_CONFIG.region}, ${instances.length} PR(s)\n`);
const report = await runner.run([genDataset], {
  campaignId: "swe-eval",
  architectures: ["agentless", "generalists-3", "hierarchical", "consensus"],
  modelVersion: LLM_CONFIG.defaultModel,
  promptVersion: "v1",
  workflowVersion: "workflow-v1",
  evaluationVersion: "eval-v1",
  platformVersion: "v1.0.0",
  awsRegion: LLM_CONFIG.region,
  generatedAt: new Date().toISOString(),
});
const runs = report.outcomes.map((o) => o.benchmarkRun);
if (process.env.RUNS_OUT) writeFileSync(process.env.RUNS_OUT, JSON.stringify(runs, null, 2));

// Judge (with rate-limit backoff, mirroring judge:eval) → coverage cache.
const cache = new CoverageScoreCache();
const precomputer = new CoverageJudgePrecomputer(provider, { ...DEFAULT_JUDGE_CONFIG, modelId: JUDGE_MODEL });
console.log(`\nJUDGE — ${JUDGE_MODEL} over (finding × golden comment) pairs...`);
const maxAttempts = 8;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    await precomputer.precompute(runs, commentsByInstance, cache);
    break;
  } catch (error) {
    if (error instanceof ProviderRateLimitError && attempt < maxAttempts) {
      const waitMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      if (process.env.CACHE_OUT) writeFileSync(process.env.CACHE_OUT, JSON.stringify(cache.toJSON(), null, 2));
      console.log(`  rate limited (attempt ${attempt}/${maxAttempts}); backing off ${waitMs}ms and resuming...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw error;
  }
}
if (process.env.CACHE_OUT) writeFileSync(process.env.CACHE_OUT, JSON.stringify(cache.toJSON(), null, 2));

// Aggregate per architecture (macro mean over instances).
const evaluator = new SemanticCoverageEvaluator(TAU);
console.log(`\n=== SWE coverage (judge τ=${TAU}) ===`);
console.log("arch".padEnd(14) + "  n   coverage  precision   f1    unmatched(≈beyond-human)");
for (const arch of ["agentless", "generalists-3", "hierarchical", "consensus"]) {
  const armRuns = runs.filter((r) => r.architecture === arch);
  if (armRuns.length === 0) continue;
  const results: SemanticCoverageResult[] = armRuns.map((r) =>
    evaluator.evaluate(r.producedFindings, commentsByInstance.get(r.instanceId) ?? [], cache),
  );
  const mean = (pick: (x: SemanticCoverageResult) => number): number =>
    results.reduce((a, x) => a + pick(x), 0) / (results.length || 1);
  const unmatched = results.reduce((a, x) => a + (x.uniqueFindingCount - x.matchedFindings), 0);
  console.log(
    arch.padEnd(14) +
      `  ${armRuns.length}   ${mean((x) => x.coverage).toFixed(2)}      ` +
      `${mean((x) => x.precision).toFixed(2)}      ${mean((x) => x.f1).toFixed(2)}   ${unmatched}`,
  );
}
```

- [ ] **Step 2: Add the npm alias**

In `package.json`, after the `"judge:eval": ...` line, add:

```json
    "swe:eval": "node scripts/benchmark-swe-eval.ts",
```

- [ ] **Step 3: Add to tsconfig include**

In `tsconfig.json` `include`, after `"scripts/benchmark-judge-eval.ts",` add:

```json
    "scripts/benchmark-swe-eval.ts",
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run check`
Expected: tsc clean; all tests pass (the new unit tests from Tasks 1–6 included).

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-swe-eval.ts package.json tsconfig.json
git commit -m "feat(swe): swe:eval script (generate → coverage judge → coverage report)"
```

---

### Task 8: Fetch `swe.json` + README + Haiku pilot (execution-time; needs AWS creds)

**Files:**
- Create: `data/benchmark/swe.json` (real Martian data)
- Modify: `data/benchmark/README.md` (SWE provenance)

- [ ] **Step 1: Fetch the data**

Download the 5 Martian golden-comment files and, for each PR, fetch its diff from GitHub via the `url`, emitting the raw SWE shape (§2 of the spec). Recipe (a throwaway script in the scratchpad, not committed — matching the Qodo precedent):
- Source: `https://raw.githubusercontent.com/withmartian/code-review-benchmark/main/offline/golden_comments/{cal_dot_com,discourse,grafana,keycloak,sentry}.json`
- Each entry: `{ pr_title, url, comments:[{comment,severity}] }`. Parse `owner/repo` + PR number from `url`; fetch the diff with `gh api repos/<owner>/<repo>/pulls/<n> -H "Accept: application/vnd.github.v3.diff"`.
- Emit `{ name: "SWE-PRBench (Martian, 50)", instances: [{ instance_id: "<repo>-<n>", pr_title, patch: <diff>, golden_comments: [...] }] }` → `data/benchmark/swe.json`. Drop (and report) any PR whose diff cannot be fetched.

- [ ] **Step 2: Validate it loads**

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { SweGoldenAdapter } from './src/benchmark/adapters/swe-golden-adapter.ts';
const ds = new SweGoldenAdapter().toDataset(JSON.parse(readFileSync('./data/benchmark/swe.json','utf8')));
console.log('instances:', ds.instances.length, 'total golden comments:', ds.instances.reduce((a,i)=>a+i.goldenComments.length,0));
"
```
Expected: ~50 instances, all with a non-empty `rawDiff` and ≥1 golden comment.

- [ ] **Step 3: Update `data/benchmark/README.md`**

Add a section documenting `swe.json`: source (Martian `golden_comments/` + GitHub diffs), the location-less nature, and that it is scored by `swe:eval` (semantic coverage), not the file+line evaluator.

- [ ] **Step 4: Haiku pilot (needs AWS creds)**

```bash
export AWS_REGION=us-east-1
export LLM_DEFAULT_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0
npm run smoke:bedrock
BENCHMARK_LIMIT=5 RUNS_OUT=/tmp/swe-runs.json CACHE_OUT=/tmp/swe-cache.json npm run swe:eval
```
Expected: 5 PRs × 4 arms complete; a per-architecture coverage/precision/f1 table prints.

- [ ] **Step 5: Commit the data + README**

```bash
git add data/benchmark/swe.json data/benchmark/README.md
git commit -m "data(benchmark): real Martian SWE-PRBench golden comments + diffs for swe:eval"
```

---

## Self-Review

**Spec coverage:** GoldenComment (T1) ✓; SWE adapter (T1) ✓; coverage judge prompt (T4) ✓; CoverageScoreCache (T3) ✓; CoverageJudgePrecomputer (T5) ✓; SemanticCoverageEvaluator + by-severity (T6) ✓; swe:eval + backoff (T7) ✓; data + pilot (T8) ✓; dedup reuse (T2, used by T5/T6) ✓; precision caveat (unmatched count printed, T7) ✓; Qodo/old-SWE path untouched (no task modifies them) ✓.

**Type consistency:** `GoldenComment {id, body, severity?}`, `SweCoverageInstance {instanceId, title, rawDiff, goldenComments}`, `coveragePairKey(finding, comment)`, `CoverageJudgePrecomputer.precompute(runs, commentsByInstance, cache)`, `SemanticCoverageEvaluator.evaluate(findings, comments, cache) → SemanticCoverageResult` — names match across T1/T3/T5/T6/T7. `dedupeFindings` (T2) used by T5+T6. `buildCoverageJudgePrompt(finding, comment, config)` (T4) used by T5.

**Placeholder scan:** none — every code step is complete. T8 is execution-time (data fetch + live pilot) and gives the exact commands.
