import { test } from "node:test";
import assert from "node:assert/strict";

import { ConsensusSynthesizer } from "../../src/architectures/consensus/consensus-synthesizer.ts";
import type { SynthesizeInput } from "../../src/architectures/consensus/consensus-synthesizer.ts";
import type { CandidateFinding } from "../../src/architectures/consensus/models/candidate-finding.ts";
import type { ReviewVote, ConsensusVoteValue } from "../../src/architectures/consensus/models/review-vote.ts";
import type { SpecialistReviewResult } from "../../src/architectures/shared/specialist-review-result.ts";
import type { AgentRole } from "../../src/architectures/shared/agent.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import { buildFinding } from "./support/stored-results.ts";

const synth = new ConsensusSynthesizer();

function specialist(role: AgentRole, findings: ReviewFinding[]): SpecialistReviewResult {
  return { role, summary: `${role}`, findings, latencyMs: 1, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 };
}

function vote(findingId: string, reviewer: AgentRole, value: ConsensusVoteValue, confidence = 0.8): ReviewVote {
  return { findingId, reviewer, vote: value, reason: "", confidence };
}

function baseInput(candidates: CandidateFinding[], votes: ReviewVote[]): SynthesizeInput {
  return {
    independentResults: [],
    revisedResults: [],
    candidates,
    votes,
    duplicateCount: 0,
    specialistCount: 3,
    llmCalls: 9,
    messageCount: 22,
    inputTokens: 30,
    outputTokens: 12,
    latencyMs: 90,
    criticalPathLatencyMs: 30,
    truncatedCallCount: 0,
    estimatedCostUsd: 0.003,
  };
}

test("generateCandidates deduplicates and accumulates source ids + proposers", () => {
  const { candidates, duplicateCount } = synth.generateCandidates(
    [specialist("backend", [buildFinding({ id: "b1", file: "a.ts", line: 10, title: "Bug" })])],
    [specialist("frontend", [buildFinding({ id: "f1", file: "a.ts", line: 10, title: "bug" })])],
  );
  assert.equal(candidates.length, 1);
  assert.equal(duplicateCount, 1);
  assert.equal(candidates[0]?.candidateId, "candidate-1");
  assert.deepEqual(candidates[0]?.proposedBy, ["backend", "frontend"]);
  assert.deepEqual(candidates[0]?.sourceFindingIds, ["b1", "f1"]);
});

test("majority accept → accepted; confidence is net support with reject votes subtracted (B5)", () => {
  const candidate: CandidateFinding = {
    candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "Bug", severity: "high",
    category: "security", file: "a.ts", line: 10, description: "d", recommendation: "r", proposedBy: ["backend"],
  };
  const result = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "accept", 0.9),
      vote("candidate-1", "frontend", "accept", 0.7),
      vote("candidate-1", "database", "reject", 0.8),
    ]),
  );
  assert.equal(result.decisions[0]?.decision, "accepted");
  assert.equal(result.decisions[0]?.acceptedVoteCount, 2);
  assert.equal(result.acceptedFindings.length, 1);
  assert.equal(result.acceptedFindings[0]?.id, "candidate-1");
  // net = (0.9 + 0.7 - 0.8) / 3 decisive votes = 0.2667 (was 0.8 mean-of-accepts).
  assert.ok(Math.abs((result.acceptedFindings[0]?.confidence ?? 0) - 0.8 / 3) < 1e-9);
  assert.equal(result.consensusMetrics.acceptedFindingCount, 1);
});

test("a reject vote lowers confidence below the pure-accept case (B5)", () => {
  const candidate: CandidateFinding = {
    candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "Bug", severity: "high",
    category: "security", file: "a.ts", line: 10, description: "d", recommendation: "r", proposedBy: ["backend"],
  };
  const allAccept = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "accept", 0.9),
      vote("candidate-1", "frontend", "accept", 0.9),
      vote("candidate-1", "database", "accept", 0.9),
    ]),
  );
  const withReject = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "accept", 0.9),
      vote("candidate-1", "frontend", "accept", 0.9),
      vote("candidate-1", "database", "reject", 0.9),
    ]),
  );
  // Both accepted (2/3 accept), but the strong dissent must reduce confidence.
  assert.equal(allAccept.acceptedFindings[0]?.confidence, 0.9);
  assert.ok(
    (withReject.acceptedFindings[0]?.confidence ?? 1) <
      (allAccept.acceptedFindings[0]?.confidence ?? 0),
  );
  // "revise" abstains: it changes neither numerator nor denominator.
  const withRevise = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "accept", 0.9),
      vote("candidate-1", "frontend", "accept", 0.9),
      vote("candidate-1", "database", "revise", 0.9),
    ]),
  );
  assert.equal(withRevise.acceptedFindings[0]?.confidence, 0.9);
});

test("majority reject → rejected (not emitted as a final finding)", () => {
  const candidate: CandidateFinding = {
    candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "Bug", severity: "low",
    category: "x", file: "a.ts", line: 1, description: "d", recommendation: "r", proposedBy: ["backend"],
  };
  const result = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "reject"),
      vote("candidate-1", "frontend", "reject"),
      vote("candidate-1", "database", "accept"),
    ]),
  );
  assert.equal(result.decisions[0]?.decision, "rejected");
  assert.equal(result.acceptedFindings.length, 0);
  assert.equal(result.consensusMetrics.rejectedFindingCount, 1);
});

test("self-vote stats separate a proposer's own votes from peers' (B4)", () => {
  const candidate: CandidateFinding = {
    candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "Bug", severity: "high",
    category: "security", file: "a.ts", line: 10, description: "d", recommendation: "r", proposedBy: ["backend"],
  };
  const result = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "accept"), // self vote, accept
      vote("candidate-1", "frontend", "accept"), // other, accept
      vote("candidate-1", "database", "reject"), // other, reject
    ]),
  );
  assert.equal(result.consensusMetrics.selfVoteCount, 1);
  assert.equal(result.consensusMetrics.selfAcceptRate, 1); // 1/1 self accepts
  assert.equal(result.consensusMetrics.otherAcceptRate, 0.5); // 1/2 peer accepts
});

test("no majority → needs-review", () => {
  const candidate: CandidateFinding = {
    candidateId: "candidate-1", sourceFindingIds: ["b1"], title: "Bug", severity: "medium",
    category: "x", file: "a.ts", line: 1, description: "d", recommendation: "r", proposedBy: ["backend"],
  };
  const result = synth.synthesize(
    baseInput([candidate], [
      vote("candidate-1", "backend", "accept"),
      vote("candidate-1", "frontend", "reject"),
      vote("candidate-1", "database", "revise"),
    ]),
  );
  assert.equal(result.decisions[0]?.decision, "needs-review");
  assert.equal(result.acceptedFindings.length, 0);
  assert.equal(result.consensusMetrics.needsReviewFindingCount, 1);
  assert.equal(result.consensusMetrics.agreementRate, 0); // 0 decisive / 1 candidate
});
