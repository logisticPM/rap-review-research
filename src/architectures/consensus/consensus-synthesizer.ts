import type { AgentRole } from "../shared/agent.ts";
import type { SpecialistReviewResult } from "../shared/specialist-review-result.ts";
import type { ReviewFinding, SeverityLevel } from "../../models/finding.ts";
import type { CandidateFinding } from "./models/candidate-finding.ts";
import type { ReviewVote } from "./models/review-vote.ts";
import type {
  ConsensusDecision,
  ConsensusDecisionValue,
} from "./models/consensus-decision.ts";
import type { ConsensusReviewResult } from "./models/consensus-review-result.ts";
import type { ConsensusMetrics } from "./models/consensus-metrics.ts";

import { areDuplicateFindings } from "../shared/finding-dedup.ts";

const SEVERITY_ORDER: Record<SeverityLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

interface CandidateAccumulator {
  candidate: CandidateFinding;
  confidence: number;
}

export interface SynthesizeInput {
  readonly independentResults: SpecialistReviewResult[];
  readonly revisedResults: SpecialistReviewResult[];
  readonly candidates: CandidateFinding[];
  readonly votes: ReviewVote[];
  readonly duplicateCount: number;
  readonly specialistCount: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly criticalPathLatencyMs: number;
  readonly truncatedCallCount: number;
  readonly estimatedCostUsd: number;
}

/**
 * Deterministic consensus synthesis (no LLM). Generates candidate findings by
 * deduplication, aggregates votes into decisions by majority rule, emits the
 * accepted findings, and computes consensus metrics. Never mutates inputs.
 */
export class ConsensusSynthesizer {
  /**
   * Deduplicate Round-1 + revised findings into candidates by near-duplicate
   * matching (same file, nearby line, similar title — see
   * {@link areDuplicateFindings}). Highest severity/confidence wins; source ids
   * and proposing roles accumulate. Candidates keep discovery order so ids are
   * stable.
   */
  public generateCandidates(
    independentResults: SpecialistReviewResult[],
    revisedResults: SpecialistReviewResult[],
  ): { candidates: CandidateFinding[]; duplicateCount: number } {
    const accumulators: CandidateAccumulator[] = [];
    let total = 0;

    const consume = (result: SpecialistReviewResult): void => {
      for (const finding of result.findings) {
        total += 1;
        const index = accumulators.findIndex((acc) =>
          areDuplicateFindings(acc.candidate, finding),
        );
        if (index === -1) {
          accumulators.push({
            candidate: {
              candidateId: `candidate-${accumulators.length + 1}`,
              sourceFindingIds: [finding.id],
              title: finding.title,
              severity: finding.severity,
              category: finding.category,
              file: finding.file,
              line: finding.line,
              description: finding.description,
              recommendation: finding.recommendation,
              proposedBy: [result.role],
            },
            confidence: finding.confidence,
          });
        } else {
          accumulators[index] = mergeInto(
            accumulators[index] as CandidateAccumulator,
            finding,
            result.role,
          );
        }
      }
    };

    for (const result of independentResults) {
      consume(result);
    }
    for (const result of revisedResults) {
      consume(result);
    }

    const candidates = accumulators.map((acc) => acc.candidate);
    return { candidates, duplicateCount: total - candidates.length };
  }

  public synthesize(input: SynthesizeInput): ConsensusReviewResult {
    const majority = Math.floor(input.specialistCount / 2) + 1;
    const confidenceByCandidate = candidateConfidence(input);

    const decisions = input.candidates.map((candidate) =>
      decide(candidate, input.votes, majority),
    );

    const acceptedFindings: ReviewFinding[] = [];
    let accepted = 0;
    let rejected = 0;
    let needsReview = 0;
    for (const decision of decisions) {
      if (decision.decision === "accepted") {
        accepted += 1;
        const candidate = input.candidates.find(
          (c) => c.candidateId === decision.candidateId,
        );
        if (candidate) {
          acceptedFindings.push(
            toReviewFinding(candidate, confidenceByCandidate.get(candidate.candidateId) ?? 0),
          );
        }
      } else if (decision.decision === "rejected") {
        rejected += 1;
      } else {
        needsReview += 1;
      }
    }

    const decisive = accepted + rejected;
    const selfVote = selfVoteStats(input.candidates, input.votes);
    const consensusMetrics: ConsensusMetrics = {
      specialistCount: input.specialistCount,
      candidateFindingCount: input.candidates.length,
      acceptedFindingCount: accepted,
      rejectedFindingCount: rejected,
      needsReviewFindingCount: needsReview,
      voteCount: input.votes.length,
      agreementRate: input.candidates.length === 0 ? 0 : decisive / input.candidates.length,
      selfVoteCount: selfVote.selfVoteCount,
      selfAcceptRate: selfVote.selfAcceptRate,
      otherAcceptRate: selfVote.otherAcceptRate,
      revisionCount: input.revisedResults.length,
      duplicateCount: input.duplicateCount,
      llmCalls: input.llmCalls,
      messageCount: input.messageCount,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      latencyMs: input.latencyMs,
      criticalPathLatencyMs: input.criticalPathLatencyMs,
      truncatedCallCount: input.truncatedCallCount,
      estimatedCostUsd: input.estimatedCostUsd,
    };

    return {
      summary:
        `Consensus of ${input.specialistCount} specialist(s): ${accepted} accepted, ` +
        `${rejected} rejected, ${needsReview} needs-review ` +
        `(from ${input.candidates.length} candidate(s)).`,
      independentResults: input.independentResults,
      revisedResults: input.revisedResults,
      candidateFindings: input.candidates,
      votes: input.votes,
      decisions,
      acceptedFindings,
      consensusMetrics,
    };
  }
}

function mergeInto(
  existing: CandidateAccumulator,
  finding: ReviewFinding,
  role: AgentRole,
): CandidateAccumulator {
  const higherSeverity =
    SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.candidate.severity];
  return {
    candidate: {
      ...existing.candidate,
      severity: higherSeverity ? finding.severity : existing.candidate.severity,
      sourceFindingIds: existing.candidate.sourceFindingIds.includes(finding.id)
        ? existing.candidate.sourceFindingIds
        : [...existing.candidate.sourceFindingIds, finding.id],
      proposedBy: existing.candidate.proposedBy.includes(role)
        ? existing.candidate.proposedBy
        : [...existing.candidate.proposedBy, role],
    },
    confidence: Math.max(existing.confidence, finding.confidence),
  };
}

function candidateConfidence(input: SynthesizeInput): Map<string, number> {
  const map = new Map<string, number>();
  // Confidence of an accepted finding = net support across its votes:
  // (sum of accept confidences - sum of reject confidences) / decisive votes.
  // Reject votes now drag confidence down instead of being ignored, so a
  // 2-accept/1-strong-reject finding is no longer as confident as 3-accept.
  // "revise" abstains from the accept/reject axis and is excluded from both.
  // Reduces to the old mean-of-accepts when there are no reject votes.
  for (const candidate of input.candidates) {
    const votes = input.votes.filter(
      (v) => v.findingId === candidate.candidateId,
    );
    let net = 0;
    let decisive = 0;
    for (const vote of votes) {
      if (vote.vote === "accept") {
        net += vote.confidence;
        decisive += 1;
      } else if (vote.vote === "reject") {
        net -= vote.confidence;
        decisive += 1;
      }
    }
    map.set(candidate.candidateId, decisive === 0 ? 0 : clamp01(net / decisive));
  }
  return map;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Self-preference stats: a vote is a "self vote" when its reviewer is among the
 * roles that proposed the candidate. Returns the self-vote count and the accept
 * rate among self votes vs. among other votes. Rates are 0 when the respective
 * group is empty.
 */
function selfVoteStats(
  candidates: CandidateFinding[],
  votes: ReviewVote[],
): { selfVoteCount: number; selfAcceptRate: number; otherAcceptRate: number } {
  const proposersByCandidate = new Map<string, ReadonlySet<AgentRole>>(
    candidates.map((c) => [c.candidateId, new Set(c.proposedBy)]),
  );

  let selfVotes = 0;
  let selfAccepts = 0;
  let otherVotes = 0;
  let otherAccepts = 0;
  for (const vote of votes) {
    const proposers = proposersByCandidate.get(vote.findingId);
    const isSelf = proposers?.has(vote.reviewer) ?? false;
    const isAccept = vote.vote === "accept";
    if (isSelf) {
      selfVotes += 1;
      if (isAccept) selfAccepts += 1;
    } else {
      otherVotes += 1;
      if (isAccept) otherAccepts += 1;
    }
  }

  return {
    selfVoteCount: selfVotes,
    selfAcceptRate: selfVotes === 0 ? 0 : selfAccepts / selfVotes,
    otherAcceptRate: otherVotes === 0 ? 0 : otherAccepts / otherVotes,
  };
}

function decide(
  candidate: CandidateFinding,
  allVotes: ReviewVote[],
  majority: number,
): ConsensusDecision {
  const votes = allVotes.filter((v) => v.findingId === candidate.candidateId);
  const acceptedVoteCount = votes.filter((v) => v.vote === "accept").length;
  const rejectedVoteCount = votes.filter((v) => v.vote === "reject").length;
  let decision: ConsensusDecisionValue = "needs-review";
  if (acceptedVoteCount >= majority) {
    decision = "accepted";
  } else if (rejectedVoteCount >= majority) {
    decision = "rejected";
  }
  return { candidateId: candidate.candidateId, decision, votes, acceptedVoteCount, rejectedVoteCount };
}

function toReviewFinding(candidate: CandidateFinding, confidence: number): ReviewFinding {
  return {
    id: candidate.candidateId,
    title: candidate.title,
    severity: candidate.severity,
    category: candidate.category,
    file: candidate.file,
    line: candidate.line,
    description: candidate.description,
    recommendation: candidate.recommendation,
    confidence,
  };
}
