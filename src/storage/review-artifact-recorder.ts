import type { HierarchicalReviewResult } from "../architectures/hierarchical/models/hierarchical-review-result.ts";
import type { ConsensusReviewResult } from "../architectures/consensus/models/consensus-review-result.ts";

/**
 * The seam a multi-agent architecture uses to hand its full intermediate result
 * to storage, without depending on a concrete repository (roadmap B1). Optional
 * everywhere: when no recorder is wired, nothing is persisted and behaviour is
 * unchanged (single-agent architectures never record).
 *
 * Defined in the storage layer alongside the other persistence ports the
 * architectures already depend on (e.g. `RawDiffStorage`).
 */
export interface ReviewArtifactRecorder {
  recordHierarchical(
    experimentId: string,
    result: HierarchicalReviewResult,
  ): Promise<void>;
  recordConsensus(
    experimentId: string,
    result: ConsensusReviewResult,
  ): Promise<void>;
}
