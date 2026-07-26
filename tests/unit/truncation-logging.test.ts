import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewExecutionInput } from "../../src/models/review-result.ts";
import { isTruncatedStopReason } from "../../src/llm/models/llm-review-response.ts";
import { AgentlessArchitecture } from "../../src/architectures/agentless/agentless-architecture.ts";
import { createHierarchicalArchitecture } from "../../src/architectures/hierarchical/index.ts";
import { InMemoryRawDiffStorage } from "../../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { PromptBuilder } from "../../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../../src/llm/prompts/context-builder.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";
import { FixedClock } from "../../src/shared/clock.ts";
import { buildSnapshot } from "./support/fixtures.ts";
import { sampleDiff } from "./support/diffs.ts";

const REVIEW_JSON = JSON.stringify({
  summary: "r",
  riskLevel: "low",
  findings: [],
});

function promptBuilder(): PromptBuilder {
  return new PromptBuilder({
    loader: new PromptLoader(),
    contextBuilder: new ContextBuilder(),
  });
}

async function input(rawDiffStorage: InMemoryRawDiffStorage): Promise<ReviewExecutionInput> {
  const snapshot = buildSnapshot();
  await rawDiffStorage.saveRawDiff(snapshot.snapshotId, sampleDiff());
  return {
    experimentId: "snap_001#a#m#v1#w1#e1",
    snapshot,
    modelVersion: "m",
    promptVersion: "v1",
    workflowVersion: "w1",
  };
}

test("isTruncatedStopReason recognizes only the max-tokens cutoff", () => {
  assert.equal(isTruncatedStopReason("max_tokens"), true);
  assert.equal(isTruncatedStopReason("end_turn"), false);
  assert.equal(isTruncatedStopReason(undefined), false);
});

test("agentless records truncatedCallCount 1 when the single call is cut off", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const arch = new AgentlessArchitecture({
    provider: new MockProvider({ response: { text: REVIEW_JSON, stopReason: "max_tokens" } }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
  });
  const raw = await arch.execute(await input(rawDiffStorage));
  assert.equal(raw.truncatedCallCount, 1);
});

test("agentless records truncatedCallCount 0 on a clean stop", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const arch = new AgentlessArchitecture({
    provider: new MockProvider({ response: { text: REVIEW_JSON, stopReason: "end_turn" } }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
  });
  const raw = await arch.execute(await input(rawDiffStorage));
  assert.equal(raw.truncatedCallCount, 0);
});

test("hierarchical sums truncation across specialist calls", async () => {
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const arch = createHierarchicalArchitecture({
    provider: new MockProvider({ response: { text: REVIEW_JSON, stopReason: "max_tokens" } }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
    clock: new FixedClock(),
  });
  const raw = await arch.execute(await input(rawDiffStorage));
  assert.equal(raw.truncatedCallCount, 3); // all three specialists truncated
});
