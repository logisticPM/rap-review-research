/**
 * Consensus-specific execution metrics. The core metrics (llmCalls, messageCount)
 * flow into RawReviewResult; the rest are architecture artifacts for future
 * dashboard/replay work.
 */
export interface ConsensusMetrics {
  readonly specialistCount: number;
  readonly candidateFindingCount: number;
  readonly acceptedFindingCount: number;
  readonly rejectedFindingCount: number;
  readonly needsReviewFindingCount: number;
  readonly voteCount: number;
  readonly agreementRate: number;
  // Self-preference instrumentation (B4): a "self vote" is a specialist voting
  // on a candidate it proposed. If self-accept rate >> other-accept rate, the
  // 2-of-3 majority is partly a specialist ratifying its own findings rather
  // than independent peer review.
  readonly selfVoteCount: number;
  readonly selfAcceptRate: number;
  readonly otherAcceptRate: number;
  readonly revisionCount: number;
  readonly duplicateCount: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  // Aggregate LLM usage across all rounds (review + revision + voting). Added
  // beyond RFC-09 §19 so RawReviewResult token/latency/cost cover every call.
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /**
   * Wall-clock lower bound (B3): the three rounds (review, revise, vote) run
   * sequentially but each round's specialists run in parallel, so this is the
   * sum of the slowest call per round — far below `latencyMs` (the sum of all
   * nine calls).
   */
  readonly criticalPathLatencyMs: number;
  /** How many of the 9 LLM calls were cut off by the output-token cap (B2). */
  readonly truncatedCallCount: number;
  readonly estimatedCostUsd: number;
}
