import type { ConsensusSession } from "../consensus-session.ts";
import type { ConsensusReviewResult } from "../models/consensus-review-result.ts";
import type { SpecialistReviewResult } from "../../shared/specialist-review-result.ts";
import type { ReviewVote } from "../models/review-vote.ts";
import type { IConsensusProtocol } from "./consensus-protocol.ts";

/**
 * The initial consensus algorithm: independent review → finding exchange →
 * revision → voting → majority-rule synthesis. Deterministic given the same
 * specialist responses. Each specialist makes 3 LLM calls (review, revise, vote)
 * → llmCalls = 3 × specialistCount.
 */
export class MajorityVoteConsensusProtocol implements IConsensusProtocol {
  public async execute(
    session: ConsensusSession,
  ): Promise<ConsensusReviewResult> {
    const { input, specialists, synthesizer } = session;
    const snapshotId = input.snapshot.snapshotId;

    // Each round dispatches its specialists in parallel (they have no data
    // dependency within a round); requests are recorded before responses in
    // specialist order so the conversation stays deterministic and messageCount
    // is unchanged. Rounds themselves remain sequential.

    // Round 1 — Independent review.
    session.transition("independent-review");
    for (const specialist of specialists) {
      session.send("coordinator", specialist.role, "review-request", { snapshotId });
    }
    const independentResults = await Promise.all(
      specialists.map((s) => s.review(input)),
    );
    specialists.forEach((s, i) => {
      session.send(s.role, "coordinator", "review-response", {
        findingCount: (independentResults[i] as SpecialistReviewResult).findings.length,
      });
    });

    // Round 2 — Finding exchange (peer findings shared with every specialist).
    session.transition("exchange");
    const peerFindings = independentResults.flatMap((r) => r.findings);
    for (const specialist of specialists) {
      session.send("coordinator", specialist.role, "exchange", {
        sharedFindingCount: peerFindings.length,
      });
    }

    // Round 3 — Revision.
    session.transition("revision");
    for (const specialist of specialists) {
      session.send("coordinator", specialist.role, "revision-request", {
        peerFindingCount: peerFindings.length,
      });
    }
    const revisedResults = await Promise.all(
      specialists.map((s) => s.revise(input, peerFindings)),
    );
    specialists.forEach((s, i) => {
      session.send(s.role, "coordinator", "revision-response", {
        findingCount: (revisedResults[i] as SpecialistReviewResult).findings.length,
      });
    });

    // Candidate generation (deduplicated, before voting).
    const { candidates, duplicateCount } = synthesizer.generateCandidates(
      independentResults,
      revisedResults,
    );

    // Round 4 — Voting.
    session.transition("voting");
    for (const specialist of specialists) {
      session.send("coordinator", specialist.role, "vote-request", {
        candidateCount: candidates.length,
      });
    }
    const voteResults = await Promise.all(
      specialists.map((s) => s.vote(input, candidates)),
    );
    const votes: ReviewVote[] = [];
    specialists.forEach((s, i) => {
      const voteResult = voteResults[i] as (typeof voteResults)[number];
      session.send(s.role, "coordinator", "vote-response", {
        voteCount: voteResult.votes.length,
      });
      votes.push(...voteResult.votes);
    });

    // Aggregate LLM usage across every round (review + revision + voting).
    const allCalls = [...independentResults, ...revisedResults, ...voteResults];
    const inputTokens = allCalls.reduce((s, r) => s + r.inputTokens, 0);
    const outputTokens = allCalls.reduce((s, r) => s + r.outputTokens, 0);
    const latencyMs = allCalls.reduce((s, r) => s + r.latencyMs, 0);
    const estimatedCostUsd = allCalls.reduce((s, r) => s + r.estimatedCostUsd, 0);
    // Critical path: three sequential rounds, each bounded by its slowest call.
    const maxLatency = (results: readonly { latencyMs: number }[]): number =>
      results.reduce((max, r) => Math.max(max, r.latencyMs), 0);
    const criticalPathLatencyMs =
      maxLatency(independentResults) +
      maxLatency(revisedResults) +
      maxLatency(voteResults);
    const truncatedCallCount = [
      ...independentResults,
      ...revisedResults,
      ...voteResults,
    ].filter((r) => r.truncated).length;

    // Synthesis (deterministic majority rule; no LLM).
    session.transition("synthesizing");
    session.send("coordinator", "coordinator", "synthesis", {
      candidateCount: candidates.length,
    });
    return synthesizer.synthesize({
      independentResults,
      revisedResults,
      candidates,
      votes,
      duplicateCount,
      specialistCount: specialists.length,
      llmCalls: specialists.length * 3,
      messageCount: session.conversation.messages.length,
      inputTokens,
      outputTokens,
      latencyMs,
      criticalPathLatencyMs,
      truncatedCallCount,
      estimatedCostUsd,
    });
  }
}
