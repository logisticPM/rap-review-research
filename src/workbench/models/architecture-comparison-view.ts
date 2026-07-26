import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { ComparisonChart } from "./comparison-chart.ts";
import type { SeverityDistribution } from "./severity-distribution.ts";

/**
 * One architecture's metrics within a side-by-side comparison, flattened for
 * display. All values are copied from the Evaluation Engine's
 * {@link ExperimentMetrics}; no calculation happens here.
 */
export interface ArchitectureComparisonRow {
  readonly architecture: ReviewArchitecture;
  readonly experimentId: string;
  readonly findingCount: number;
  readonly severityDistribution: SeverityDistribution;
  readonly averageConfidence: number;
  /** Supporting heuristic (severity + confidence + volume), NOT correctness. */
  readonly evidenceScore: number;
  /** Cross-architecture agreement (RAP Portal corroboration); absent when not computable. */
  readonly architectureAgreement?: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
}

/**
 * The Architecture Comparison page (RFC-11 §12): every architecture that
 * reviewed one snapshot, side by side, plus ready-to-render charts. A pure
 * presentation transform of an {@link ExperimentComparison}.
 */
export interface ArchitectureComparisonView {
  readonly snapshotId: string;
  readonly architectures: ArchitectureComparisonRow[];
  readonly charts: ComparisonChart[];
}
