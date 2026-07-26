import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "./ground-truth-issue.ts";

/**
 * The record of one architecture reviewing one benchmark instance: the findings
 * it produced, paired with the instance's ground truth. It is the atomic unit
 * the ground-truth evaluator scores.
 *
 * A benchmark subset run over N instances × 3 architectures produces 3·N of
 * these — every instance reviewed by all three architectures (the comparison is
 * preserved by construction).
 */
export interface BenchmarkRun {
  readonly runId: string;
  readonly datasetId: string;
  readonly instanceId: string;
  readonly snapshotId: string;
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly producedFindings: ReviewFinding[];
  readonly groundTruth: GroundTruthIssue[];
  /**
   * The instance's unified diff. Optional; when present, the evaluator anchors
   * findings that carry a `snippet` to their true line for snippet-anchored
   * localization (A3 eval-side).
   */
  readonly rawDiff?: string;
}
