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
  assert.equal(raw.messageCount, 3);
  assert.equal(findings.length, 2);
  assert.equal(raw.latencyMs, 70);
  assert.equal(raw.criticalPathLatencyMs, 40);
  const ids = findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
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

test("sampleCount 1 is the degenerate single-sample case (C1)", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const responder = (_r: LLMReviewRequest) => ({
    text: review([finding("a.ts", 10, "Bug X")]),
    latencyMs: 15,
  });
  const arch = new GeneralistsArchitecture({
    provider: new MockProvider({ responder }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
    sampleCount: 1,
  });

  const raw = await arch.execute(await input(rawDiffStorage));

  assert.equal(raw.llmCalls, 1);
  assert.equal(raw.messageCount, 1);
  assert.equal(raw.criticalPathLatencyMs, raw.latencyMs);
});

test("all-empty samples yield no findings without throwing (C1)", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const responder = (_r: LLMReviewRequest) => ({ text: review([]) });
  const arch = new GeneralistsArchitecture({
    provider: new MockProvider({ responder }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
  });

  const raw = await arch.execute(await input(rawDiffStorage));

  assert.equal((raw.findings as ReviewFinding[]).length, 0);
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
