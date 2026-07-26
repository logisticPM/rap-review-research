import type { ReviewFinding } from "../models/finding.ts";
import type { HierarchicalReviewResult } from "./hierarchical/models/hierarchical-review-result.ts";
import type { ConsensusReviewResult } from "./consensus/models/consensus-review-result.ts";

import { Synthesizer } from "./hierarchical/synthesizer.ts";
import { ConsensusSynthesizer } from "./consensus/consensus-synthesizer.ts";

/**
 * Offline replay of multi-agent synthesis (roadmap B1).
 *
 * Given a persisted intermediate result, re-run the *deterministic* synthesis
 * step — the same code the live architecture used — to recompute the final
 * findings. Makes NO LLM calls: it consumes only the stored per-round specialist
 * outputs, candidates, and votes. Because synthesis is deterministic, the
 * recomputed findings must equal the ones the live run recorded; that equality
 * is the replay guarantee (verified in tests and `scripts/verify-replay.ts`).
 */

/** Re-synthesize the hierarchical merged findings from stored specialist results. */
export function replayHierarchicalFindings(
  result: HierarchicalReviewResult,
): ReviewFinding[] {
  return new Synthesizer().synthesize(result.specialistResults).mergedFindings;
}

/**
 * Re-run consensus synthesis from stored rounds + votes. Candidates are
 * regenerated from the independent/revised results (proving dedup is
 * deterministic) and must match the stored candidates; the stored votes —
 * keyed by the deterministic `candidate-N` ids — then drive the majority-rule
 * decision to reproduce the accepted findings.
 */
export function replayConsensusFindings(
  result: ConsensusReviewResult,
): ReviewFinding[] {
  const synthesizer = new ConsensusSynthesizer();
  const { candidates, duplicateCount } = synthesizer.generateCandidates(
    result.independentResults,
    result.revisedResults,
  );
  const metrics = result.consensusMetrics;
  return synthesizer.synthesize({
    independentResults: result.independentResults,
    revisedResults: result.revisedResults,
    candidates,
    votes: result.votes,
    duplicateCount,
    specialistCount: metrics.specialistCount,
    llmCalls: metrics.llmCalls,
    messageCount: metrics.messageCount,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    latencyMs: metrics.latencyMs,
    criticalPathLatencyMs: metrics.criticalPathLatencyMs,
    truncatedCallCount: metrics.truncatedCallCount,
    estimatedCostUsd: metrics.estimatedCostUsd,
  }).acceptedFindings;
}
