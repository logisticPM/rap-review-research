import type { ReviewArchitecture } from "../models/experiment.ts";
import type { HierarchicalReviewResult } from "../architectures/hierarchical/models/hierarchical-review-result.ts";
import type { ConsensusReviewResult } from "../architectures/consensus/models/consensus-review-result.ts";

/**
 * The full intermediate result of a multi-agent review, persisted so the
 * deterministic synthesis can be re-run offline with zero LLM calls (roadmap
 * B1). Exactly one of `hierarchical`/`consensus` is set, matching
 * `architecture`. Single-agent (agentless) runs have no intermediates and
 * produce no artifact.
 *
 * These carry every input the synthesizers need to reproduce the final
 * findings: per-specialist round outputs, candidates, votes, and decisions.
 * (Raw per-call request/response text and stop reason are a documented
 * provenance follow-up — see roadmap B1/B2 — and are not required for the
 * deterministic replay guarantee.)
 */
export interface StoredReviewArtifact {
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly storedAt: string;
  readonly hierarchical?: HierarchicalReviewResult;
  readonly consensus?: ConsensusReviewResult;
}
