import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewExecutionInput } from "../../src/models/review-result.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { LLMReviewRequest } from "../../src/llm/models/llm-review-request.ts";
import type { StoredReviewArtifact } from "../../src/storage/stored-artifacts.ts";

import { InMemoryArtifactRepository } from "../../src/storage/in-memory/in-memory-artifact-repository.ts";
import { RepositoryArtifactRecorder } from "../../src/storage/repository-artifact-recorder.ts";
import { DuplicateArtifactError } from "../../src/storage/storage-errors.ts";
import { InMemoryRawDiffStorage } from "../../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { createHierarchicalArchitecture } from "../../src/architectures/hierarchical/index.ts";
import { createConsensusArchitecture } from "../../src/architectures/consensus/index.ts";
import {
  replayHierarchicalFindings,
  replayConsensusFindings,
} from "../../src/architectures/replay.ts";
import { PromptBuilder } from "../../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../../src/llm/prompts/context-builder.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";
import { FixedClock } from "../../src/shared/clock.ts";
import { buildSnapshot } from "./support/fixtures.ts";
import { sampleDiff } from "./support/diffs.ts";

const REVIEW_JSON = JSON.stringify({
  summary: "review",
  riskLevel: "medium",
  findings: [
    {
      title: "Shared concern",
      severity: "medium",
      category: "correctness",
      file: "src/api/users.ts",
      line: 11,
      description: "Something to check.",
      recommendation: "Check it.",
      confidence: 0.7,
    },
  ],
});
const VOTE_JSON = JSON.stringify({
  votes: [{ candidateId: "candidate-1", vote: "accept", reason: "agree", confidence: 0.8 }],
});

/** A call-counting responder; voting prompts get votes, others get a review. */
function countingResponder() {
  const counter = { calls: 0 };
  const respond = (request: LLMReviewRequest) => {
    counter.calls += 1;
    return request.systemPrompt.includes("voting round")
      ? { text: VOTE_JSON }
      : { text: REVIEW_JSON };
  };
  return { counter, respond };
}

function promptBuilder(): PromptBuilder {
  return new PromptBuilder({
    loader: new PromptLoader(),
    contextBuilder: new ContextBuilder(),
  });
}

async function buildInput(
  rawDiffStorage: InMemoryRawDiffStorage,
  architecture: string,
): Promise<ReviewExecutionInput> {
  const snapshot = buildSnapshot();
  await rawDiffStorage.saveRawDiff(snapshot.snapshotId, sampleDiff());
  return {
    experimentId: `${snapshot.snapshotId}#${architecture}#m#v1#w1#e1`,
    snapshot,
    modelVersion: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    promptVersion: "v1",
    workflowVersion: "w1",
  };
}

test("artifact repository stores, returns a copy, and rejects duplicates", async () => {
  const repo = new InMemoryArtifactRepository();
  const artifact: StoredReviewArtifact = {
    experimentId: "e1",
    architecture: "hierarchical",
    storedAt: "2026-07-08T00:00:00.000Z",
    hierarchical: {
      managerSummary: "s",
      specialistResults: [],
      mergedFindings: [],
      duplicateCount: 0,
    },
  };
  await repo.save(artifact);
  assert.deepEqual(await repo.getByExperimentId("e1"), artifact);
  assert.equal(await repo.getByExperimentId("missing"), null);
  await assert.rejects(() => repo.save(artifact), DuplicateArtifactError);
});

test("hierarchical: replay recomputes merged findings from the stored artifact with zero LLM calls", async () => {
  const { counter, respond } = countingResponder();
  const repo = new InMemoryArtifactRepository();
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const arch = createHierarchicalArchitecture({
    provider: new MockProvider({ responder: respond }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
    clock: new FixedClock(),
    artifactRecorder: new RepositoryArtifactRecorder(repo, new FixedClock()),
  });

  const input = await buildInput(rawDiffStorage, "hierarchical");
  const raw = await arch.execute(input);
  const liveFindings = raw.findings as ReviewFinding[];
  const callsAfterRun = counter.calls;
  assert.equal(callsAfterRun, 3); // one call per specialist

  const artifact = await repo.getByExperimentId(input.experimentId);
  assert.ok(artifact?.hierarchical, "artifact persisted");

  const replayed = replayHierarchicalFindings(artifact.hierarchical);
  assert.equal(counter.calls, callsAfterRun, "replay made no LLM calls");
  assert.deepEqual(replayed, liveFindings);
});

test("consensus: replay recomputes accepted findings from the stored artifact with zero LLM calls", async () => {
  const { counter, respond } = countingResponder();
  const repo = new InMemoryArtifactRepository();
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const arch = createConsensusArchitecture({
    provider: new MockProvider({ responder: respond }),
    promptBuilder: promptBuilder(),
    rawDiffStorage,
    clock: new FixedClock(),
    artifactRecorder: new RepositoryArtifactRecorder(repo, new FixedClock()),
  });

  const input = await buildInput(rawDiffStorage, "consensus");
  const raw = await arch.execute(input);
  const liveFindings = raw.findings as ReviewFinding[];
  const callsAfterRun = counter.calls;
  assert.equal(callsAfterRun, 9); // 3 specialists × (review + revise + vote)
  assert.equal(liveFindings.length, 1); // three identical findings → one accepted

  const artifact = await repo.getByExperimentId(input.experimentId);
  assert.ok(artifact?.consensus, "artifact persisted");

  const replayed = replayConsensusFindings(artifact.consensus);
  assert.equal(counter.calls, callsAfterRun, "replay made no LLM calls");
  assert.deepEqual(replayed, liveFindings);
});
