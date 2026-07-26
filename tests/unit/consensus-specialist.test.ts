import { test } from "node:test";
import assert from "node:assert/strict";

import { ConsensusSpecialist } from "../../src/architectures/consensus/consensus-specialist.ts";
import { PromptBuilder } from "../../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../../src/llm/prompts/context-builder.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";
import { InMemoryRawDiffStorage } from "../../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import type { LLMReviewRequest } from "../../src/llm/models/llm-review-request.ts";
import type { ReviewExecutionInput } from "../../src/models/review-result.ts";
import type { CandidateFinding } from "../../src/architectures/consensus/models/candidate-finding.ts";
import { buildSnapshot } from "./support/fixtures.ts";
import { sampleDiff } from "./support/diffs.ts";

const REVIEW_JSON = JSON.stringify({
  summary: "backend review",
  findings: [
    {
      title: "Missing authorization",
      severity: "high",
      category: "security",
      file: "src/api/users.ts",
      line: 11,
      description: "No auth check.",
      recommendation: "Add a guard.",
      confidence: 0.9,
    },
  ],
});

const VOTE_JSON = JSON.stringify({
  votes: [{ candidateId: "candidate-1", vote: "accept", reason: "agree", confidence: 0.85 }],
});

/** Responder: voting prompts get votes; everything else gets a review. */
function responder(request: LLMReviewRequest) {
  return request.systemPrompt.includes("voting round")
    ? { text: VOTE_JSON }
    : { text: REVIEW_JSON };
}

async function specialist(): Promise<{
  specialist: ConsensusSpecialist;
  input: ReviewExecutionInput;
  calls: LLMReviewRequest[];
}> {
  const calls: LLMReviewRequest[] = [];
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const snapshot = buildSnapshot();
  await rawDiffStorage.saveRawDiff(snapshot.snapshotId, sampleDiff());
  const s = new ConsensusSpecialist("backend", {
    provider: new MockProvider({ responder, onReview: (r) => calls.push(r) }),
    promptBuilder: new PromptBuilder({ loader: new PromptLoader(), contextBuilder: new ContextBuilder() }),
    rawDiffStorage,
  });
  const input: ReviewExecutionInput = {
    experimentId: "e",
    snapshot,
    modelVersion: "m",
    promptVersion: "v1",
    workflowVersion: "w1",
  };
  return { specialist: s, input, calls };
}

test("review uses the consensus review template and parses findings", async () => {
  const { specialist: s, input, calls } = await specialist();
  const result = await s.review(input);
  assert.equal(result.role, "backend");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "high");
  assert.match(calls[0]?.systemPrompt ?? "", /Backend Reviewer in the Decentralized Consensus/);
});

test("revise injects peer findings and returns revised findings", async () => {
  const { specialist: s, input, calls } = await specialist();
  await s.review(input);
  const revised = await s.revise(input, [
    { id: "f1", title: "Peer", severity: "low", category: "x", file: "z.ts", line: 1, description: "d", recommendation: "r", confidence: 0.5 },
  ]);
  assert.equal(revised.findings.length, 1);
  const revisionCall = calls[calls.length - 1];
  assert.match(revisionCall?.systemPrompt ?? "", /revision round/);
  assert.match(revisionCall?.userPrompt ?? "", /Peer findings/); // additionalContext injected
});

// Regression: the review and revision rounds must inject the findings JSON
// schema (without it the model returns Markdown and every finding is dropped →
// 0 findings). The voting round must NOT — its template embeds its own
// { votes: [...] } shape, and a findings schema would fight it.
test("review and revise inject the findings schema; vote does not", async () => {
  const { specialist: s, input, calls } = await specialist();

  await s.review(input);
  const reviewCall = calls[calls.length - 1];
  assert.ok(reviewCall?.jsonSchema, "review must carry a jsonSchema");
  assert.match(reviewCall?.userPrompt ?? "", /Expected JSON schema/);

  await s.revise(input, [
    { id: "f1", title: "Peer", severity: "low", category: "x", file: "z.ts", line: 1, description: "d", recommendation: "r", confidence: 0.5 },
  ]);
  const reviseCall = calls[calls.length - 1];
  assert.ok(reviseCall?.jsonSchema, "revise must carry a jsonSchema");
  assert.match(reviseCall?.userPrompt ?? "", /Expected JSON schema/);

  await s.vote(input, [
    { candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "T", severity: "high", category: "c", file: "a.ts", line: 1, description: "d", recommendation: "r", proposedBy: ["backend"] },
  ]);
  const voteCall = calls[calls.length - 1];
  assert.equal(voteCall?.jsonSchema, undefined, "vote round must not inject a findings schema");
  assert.doesNotMatch(voteCall?.userPrompt ?? "", /Expected JSON schema/);
});

test("vote parses votes and reports usage", async () => {
  const { specialist: s, input } = await specialist();
  const candidates: CandidateFinding[] = [
    { candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "T", severity: "high", category: "c", file: "a.ts", line: 1, description: "d", recommendation: "r", proposedBy: ["backend"] },
  ];
  const result = await s.vote(input, candidates);
  assert.equal(result.votes.length, 1);
  assert.equal(result.votes[0]?.vote, "accept");
  assert.equal(result.votes[0]?.reviewer, "backend");
  assert.equal(typeof result.inputTokens, "number");
});
