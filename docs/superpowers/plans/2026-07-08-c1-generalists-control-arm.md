# C1 — `generalists-3` Compute-Matched Control Arm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one review architecture, `generalists-3`, that runs the generalist (agentless) prompt N=3 times at temperature > 0 and merges the samples with the same deterministic `Synthesizer` hierarchical uses — the control arm that separates "more compute" and "role specialization" from topology.

**Architecture:** A new `IReviewArchitecture` in `src/architectures/generalists/`. It reuses the agentless prompt template, the shared `parseSpecialistReview` parser, the hierarchical `Synthesizer`, and the B2/B3 metric conventions. No changes to the engine, evaluation, or export — those are keyed on the `ReviewArchitecture` string union, so the new arm flows through them once the union includes it.

**Tech Stack:** TypeScript (strict, native Node type-stripping), `node:test`, zod (validation, unchanged here). Node ≥ 22.18.

**Spec:** `docs/superpowers/specs/2026-07-08-c1-compute-matched-controls-design.md`

---

## File Structure

- **Modify** `src/models/experiment.ts` — add `"generalists-3"` to the `ReviewArchitecture` union.
- **Modify** `src/architectures/shared/agent.ts` — add `"generalist"` to the `AgentRole` union (so samples can be wrapped as `SpecialistReviewResult` for the shared `Synthesizer`).
- **Create** `src/architectures/generalists/generalists-architecture.ts` — the arm + `createGeneralistsArchitecture` helper.
- **Create** `src/architectures/generalists/index.ts` — barrel.
- **Create** `src/architectures/generalists/README.md` — module doc incl. the temperature-deviation note.
- **Modify** `src/architectures/index.ts` — re-export the new arm.
- **Modify** `scripts/benchmark-shared.ts` — register the arm in `buildBenchmarkPipeline` (opt-in; not added to `ALL_ARCHITECTURES`).
- **Create** `tests/unit/generalists-architecture.test.ts` — behavior tests.

---

## Task 1: Extend the type unions

**Files:**
- Modify: `src/models/experiment.ts`
- Modify: `src/architectures/shared/agent.ts`

Type-only change (no runtime behavior); verified by `npx tsc --noEmit` and exercised by Task 2's tests.

- [ ] **Step 1: Add the architecture name**

In `src/models/experiment.ts`, change the union:

```ts
export type ReviewArchitecture =
  | "agentless"
  | "hierarchical"
  | "consensus"
  | "generalists-3";
```

- [ ] **Step 2: Add the generalist agent role**

In `src/architectures/shared/agent.ts`, change the union:

```ts
export type AgentRole =
  | "manager"
  | "coordinator"
  | "backend"
  | "frontend"
  | "database"
  | "generalist";
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `npx tsc --noEmit`
Expected: no errors (both are additive union members; there are no exhaustive switches on either type).

- [ ] **Step 4: Commit**

```bash
git add src/models/experiment.ts src/architectures/shared/agent.ts
git commit -m "feat(types): add generalists-3 architecture + generalist role (C1)"
```

---

## Task 2: `GeneralistsArchitecture`

**Files:**
- Create: `src/architectures/generalists/generalists-architecture.ts`
- Test: `tests/unit/generalists-architecture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/generalists-architecture.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewExecutionInput } from "../../src/models/review-result.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { LLMReviewRequest } from "../../src/llm/models/llm-review-request.ts";
import { GeneralistsArchitecture } from "../../src/architectures/generalists/generalists-architecture.ts";
import { InMemoryRawDiffStorage } from "../../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { InMemoryArchitectureRegistry } from "../../src/architectures/in-memory-architecture-registry.ts";
import { PromptBuilder } from "../../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../../src/llm/prompts/context-builder.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";
import { buildSnapshot } from "./support/fixtures.ts";
import { sampleDiff } from "./support/diffs.ts";

function promptBuilder(): PromptBuilder {
  return new PromptBuilder({ loader: new PromptLoader(), contextBuilder: new ContextBuilder() });
}

function finding(file: string, line: number, title: string) {
  return {
    title, severity: "medium", category: "correctness", file, line,
    description: "d", recommendation: "r", confidence: 0.7,
  };
}

function review(findings: ReturnType<typeof finding>[]): string {
  return JSON.stringify({ summary: "s", riskLevel: "medium", findings });
}

async function input(rawDiffStorage: InMemoryRawDiffStorage): Promise<ReviewExecutionInput> {
  const snapshot = buildSnapshot();
  await rawDiffStorage.saveRawDiff(snapshot.snapshotId, sampleDiff());
  return {
    experimentId: "snap_001#generalists-3#m#v1#w1#e1",
    snapshot,
    modelVersion: "m",
    promptVersion: "v1",
    workflowVersion: "w1",
  };
}

test("runs sampleCount samples, merges duplicates, reports dual latency (C1)", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  let calls = 0;
  const responder = (_r: LLMReviewRequest) => {
    calls += 1;
    if (calls === 1) return { text: review([finding("a.ts", 10, "Bug X")]), latencyMs: 10 };
    if (calls === 2) {
      return { text: review([finding("a.ts", 10, "Bug X"), finding("b.ts", 5, "Bug Y")]), latencyMs: 40 };
    }
    return { text: review([finding("a.ts", 10, "Bug X")]), latencyMs: 20 };
  };
  const arch = new GeneralistsArchitecture({
    provider: new MockProvider({ responder }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
  });

  const raw = await arch.execute(await input(rawDiffStorage));
  const findings = raw.findings as ReviewFinding[];

  assert.equal(raw.architecture, "generalists-3");
  assert.equal(raw.llmCalls, 3);
  assert.equal(raw.messageCount, 3); // zero inter-agent messages; one per sample
  assert.equal(findings.length, 2); // "Bug X" deduped across samples; "Bug Y" kept
  assert.equal(raw.latencyMs, 70); // 10 + 40 + 20 (sum of calls)
  assert.equal(raw.criticalPathLatencyMs, 40); // slowest sample (one parallel round)
  const ids = findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length); // finding ids are unique after merge
});

test("counts truncated samples (C1 + B2)", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  let calls = 0;
  const responder = (_r: LLMReviewRequest) => {
    calls += 1;
    const stopReason = calls === 2 ? "max_tokens" : "end_turn";
    return { text: review([finding("a.ts", calls, `Bug ${calls}`)]), stopReason };
  };
  const arch = new GeneralistsArchitecture({
    provider: new MockProvider({ responder }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
  });
  const raw = await arch.execute(await input(rawDiffStorage));
  assert.equal(raw.truncatedCallCount, 1);
});

test("registry resolves the generalists-3 name (C1)", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const registry = new InMemoryArchitectureRegistry();
  registry.register(
    new GeneralistsArchitecture({
      provider: new MockProvider(),
      promptBuilder: promptBuilder(),
      rawDiffStorage,
    }),
  );
  assert.equal(registry.get("generalists-3").name, "generalists-3");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types tests/unit/generalists-architecture.test.ts`
Expected: FAIL — cannot find module `generalists-architecture.ts`.

- [ ] **Step 3: Implement the architecture**

Create `src/architectures/generalists/generalists-architecture.ts`:

```ts
import type { IReviewArchitecture } from "../review-architecture.ts";
import type { ReviewArchitecture } from "../../models/experiment.ts";
import type {
  ReviewExecutionInput,
  RawReviewResult,
} from "../../models/review-result.ts";
import type { ReviewFinding, RiskLevel } from "../../models/finding.ts";
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { PromptBuilder, PromptRole } from "../../llm/prompts/prompt-builder.ts";
import type { RawDiffStorage } from "../../storage/raw-diff-storage.ts";
import type { LLMConfig } from "../../config/llm.ts";
import type { SpecialistReviewResult } from "../shared/specialist-review-result.ts";

import { LLM_CONFIG } from "../../config/llm.ts";
import { isTruncatedStopReason } from "../../llm/models/llm-review-response.ts";
import { parseSpecialistReview } from "../shared/review-specialist.ts";
import { Synthesizer } from "../hierarchical/synthesizer.ts";

/** The generalist prompt is the Agentless system template (single generalist reviewer). */
const GENERALIST_ROLE: PromptRole = { category: "agentless", name: "system" };
const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_SAMPLE_TEMPERATURE = 0.7;

export interface GeneralistsArchitectureDependencies {
  readonly provider: ILLMProvider;
  readonly promptBuilder: PromptBuilder;
  readonly rawDiffStorage: RawDiffStorage;
  /** Inference parameters. `temperature` here is NOT used for sampling — see `sampleTemperature`. */
  readonly config?: LLMConfig;
  /** Number of independent generalist samples (default 3). */
  readonly sampleCount?: number;
  /**
   * Sampling temperature for the generalist calls (default 0.7). Deliberately
   * > 0: identical-prompt sampling at temperature 0 would be degenerate. This is
   * the one arm whose temperature differs from the temperature-0 default — a
   * documented threat to validity (README + spec).
   */
  readonly sampleTemperature?: number;
  readonly synthesizer?: Synthesizer;
}

/**
 * The compute-matched control arm (roadmap C1): the generalist (agentless)
 * prompt sampled `sampleCount` times at `sampleTemperature`, merged by the same
 * deterministic `Synthesizer` hierarchical uses. Sits between Agentless and
 * Hierarchical on the ladder — isolating "more compute" (vs agentless) and
 * "role specialization" (vs hierarchical) with agent count and merge held
 * constant.
 */
export class GeneralistsArchitecture implements IReviewArchitecture {
  public readonly name: ReviewArchitecture = "generalists-3";

  private readonly provider: ILLMProvider;
  private readonly promptBuilder: PromptBuilder;
  private readonly rawDiffStorage: RawDiffStorage;
  private readonly config: LLMConfig;
  private readonly sampleCount: number;
  private readonly sampleTemperature: number;
  private readonly synthesizer: Synthesizer;

  public constructor(deps: GeneralistsArchitectureDependencies) {
    this.provider = deps.provider;
    this.promptBuilder = deps.promptBuilder;
    this.rawDiffStorage = deps.rawDiffStorage;
    this.config = deps.config ?? LLM_CONFIG;
    this.sampleCount = deps.sampleCount ?? DEFAULT_SAMPLE_COUNT;
    this.sampleTemperature = deps.sampleTemperature ?? DEFAULT_SAMPLE_TEMPERATURE;
    this.synthesizer = deps.synthesizer ?? new Synthesizer();
  }

  public async execute(input: ReviewExecutionInput): Promise<RawReviewResult> {
    const rawDiff = await this.rawDiffStorage.getRawDiff(input.snapshot.rawDiffS3Key);
    const request = this.promptBuilder.build({
      promptVersion: input.promptVersion,
      role: GENERALIST_ROLE,
      snapshot: input.snapshot,
      rawDiff,
      modelId: input.modelVersion,
      temperature: this.sampleTemperature,
      maxTokens: this.config.maxTokens,
    });

    // Independent samples in parallel — no data dependency between them.
    const responses = await Promise.all(
      Array.from({ length: this.sampleCount }, () => this.provider.review(request)),
    );

    const samples: SpecialistReviewResult[] = responses.map((response, i) => {
      const parsed = parseSpecialistReview(response.text, "generalist");
      return {
        role: "generalist",
        summary: parsed.summary,
        // Suffix ids per sample so identical-role findings stay unique pre-merge.
        findings: parsed.findings.map((f) => ({ ...f, id: `${f.id}#${i + 1}` })),
        latencyMs: response.latencyMs,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        estimatedCostUsd: response.estimatedCostUsd,
        truncated: isTruncatedStopReason(response.stopReason),
      };
    });

    const merged = this.synthesizer.synthesize(samples);
    return toRawReviewResult(merged.mergedFindings, merged.duplicateCount, samples);
  }
}

/** Compose a RawReviewResult from the merged findings + per-sample metrics. */
function toRawReviewResult(
  findings: ReviewFinding[],
  duplicateCount: number,
  samples: SpecialistReviewResult[],
): RawReviewResult {
  const sum = (pick: (s: SpecialistReviewResult) => number): number =>
    samples.reduce((acc, s) => acc + pick(s), 0);
  const summary =
    `Generalist self-consistency over ${samples.length} sample(s): ` +
    `${findings.length} finding(s) after removing ${duplicateCount} duplicate(s).`;
  const rawOutput = JSON.stringify({
    summary,
    riskLevel: deriveRiskLevel(findings),
    findings,
  });
  return {
    architecture: "generalists-3",
    summary,
    rawOutput,
    findings,
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    latencyMs: sum((s) => s.latencyMs),
    // One parallel round: the critical path is the slowest sample.
    criticalPathLatencyMs: samples.reduce((m, s) => Math.max(m, s.latencyMs), 0),
    truncatedCallCount: samples.filter((s) => s.truncated).length,
    estimatedCostUsd: sum((s) => s.estimatedCostUsd),
    messageCount: samples.length, // one review per sample; zero inter-agent messages
    llmCalls: samples.length,
  };
}

function deriveRiskLevel(findings: ReviewFinding[]): RiskLevel {
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  let max = 0;
  for (const finding of findings) {
    max = Math.max(max, order.indexOf(finding.severity));
  }
  return order[max] ?? "low";
}

/** Composition helper mirroring create{Hierarchical,Consensus}Architecture. */
export function createGeneralistsArchitecture(deps: {
  provider: ILLMProvider;
  promptBuilder: PromptBuilder;
  rawDiffStorage: RawDiffStorage;
  config?: LLMConfig;
  sampleCount?: number;
  sampleTemperature?: number;
}): GeneralistsArchitecture {
  return new GeneralistsArchitecture(deps);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types tests/unit/generalists-architecture.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/architectures/generalists/generalists-architecture.ts tests/unit/generalists-architecture.test.ts
git commit -m "feat(architectures): generalists-3 compute-matched control arm (C1)"
```

---

## Task 3: Barrel exports, module README, pipeline registration

**Files:**
- Create: `src/architectures/generalists/index.ts`
- Create: `src/architectures/generalists/README.md`
- Modify: `src/architectures/index.ts`
- Modify: `scripts/benchmark-shared.ts`

- [ ] **Step 1: Create the module barrel**

Create `src/architectures/generalists/index.ts`:

```ts
export {
  GeneralistsArchitecture,
  createGeneralistsArchitecture,
} from "./generalists-architecture.ts";
export type { GeneralistsArchitectureDependencies } from "./generalists-architecture.ts";
```

- [ ] **Step 2: Create the module README**

Create `src/architectures/generalists/README.md`:

```markdown
# Generalists Control Arm (`generalists-3`) — roadmap C1

The compute-matched control between Agentless and Hierarchical. Runs the
generalist (Agentless) prompt `sampleCount` times (default 3) at
`sampleTemperature` (default 0.7), in parallel, then merges the samples with the
**same deterministic `Synthesizer`** the Hierarchical arm uses.

```
agentless (1)  ──+compute──▶  generalists-3 (3 + merge)  ──+roles──▶  hierarchical  ──+comm──▶  consensus
```

- `llmCalls = sampleCount`; `messageCount = sampleCount` with **zero inter-agent
  messages** (more compute, no communication).
- Dual latency (B3): `latencyMs` = sum of samples; `criticalPathLatencyMs` = the
  slowest sample. Truncation (B2): `truncatedCallCount` = truncated samples.

## Threat to validity — temperature

This is the only arm that runs at temperature > 0; the others run at
temperature 0. Identical-prompt sampling at temperature 0 would be degenerate
(three identical outputs), so a non-zero temperature is intrinsic to
self-consistency. `sampleTemperature` is frozen alongside the prompts and must
be reported in the results.

## Usage

`registry.register(createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }))`
Then run an experiment with `architecture: "generalists-3"`. Not part of the
default `ALL_ARCHITECTURES` benchmark set — opt in via
`BenchmarkExecutionConfig.architectures`.
```

- [ ] **Step 3: Re-export from the architectures barrel**

In `src/architectures/index.ts`, add after the consensus export block:

```ts
export {
  GeneralistsArchitecture,
  createGeneralistsArchitecture,
} from "./generalists/index.ts";
export type { GeneralistsArchitectureDependencies } from "./generalists/index.ts";
```

- [ ] **Step 4: Register the arm in the benchmark pipeline**

In `scripts/benchmark-shared.ts`:

Add the import near the other `create*` imports:

```ts
import { createGeneralistsArchitecture } from "../src/architectures/generalists/index.ts";
```

Then, in `buildBenchmarkPipeline`, register it after the consensus registration
(it is available but not in `ALL_ARCHITECTURES`, so default runs are unchanged):

```ts
  registry.register(
    createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }),
  );
```

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: `tsc --strict` clean; all tests pass (previous count + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/architectures/generalists/index.ts src/architectures/generalists/README.md src/architectures/index.ts scripts/benchmark-shared.ts
git commit -m "feat(architectures): export + register generalists-3 arm (C1)"
```

---

## Self-review checklist (completed while writing)

- **Spec coverage:** one arm (✔ Task 2), temp>0 sampling with configurable `sampleCount`/`sampleTemperature` (✔ Task 2 deps), same `Synthesizer` merge (✔ Task 2), union wiring (✔ Task 1), not in `ALL_ARCHITECTURES` (✔ Task 3 Step 4), `messageCount = sampleCount` zero inter-agent (✔ `toRawReviewResult`), dual latency + truncation reused (✔), deferred artifact persistence (✔ — no recorder wired), temperature-deviation documented (✔ README + code doc).
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `GENERALIST_ROLE` uses `PromptRole`; samples typed `SpecialistReviewResult` with `role: "generalist"` (added in Task 1); `parseSpecialistReview(text, "generalist")` matches its `(text, AgentRole)` signature; `RawReviewResult` fields (`criticalPathLatencyMs`, `truncatedCallCount`) exist from Phase 0.
