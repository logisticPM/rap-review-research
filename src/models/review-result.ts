import type { ReviewArchitecture } from "./experiment.ts";
import type { PRSnapshot } from "./snapshot.ts";
import type { ReviewFinding } from "./finding.ts";
import type { ValidationMetadata } from "./validation-metadata.ts";

/**
 * The uniform input every review architecture receives.
 *
 * Identical for all architectures so that communication topology remains the
 * only independent variable.
 */
export interface ReviewExecutionInput {
  readonly experimentId: string;
  readonly snapshot: PRSnapshot;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly workflowVersion: string;
}

/**
 * The unvalidated output of a review architecture, together with the
 * execution-level metrics the Experiment Engine records (RFC-03 shape).
 *
 * `summary` and `findings` carry the architecture's self-reported review, while
 * `rawOutput` keeps the original unstructured payload. All three are untrusted:
 * the Experiment Engine never inspects them — turning them into a validated
 * result is the job of the Validation Engine (a future RFC). `findings` is
 * therefore typed as `unknown`.
 */
export interface RawReviewResult {
  readonly architecture: ReviewArchitecture;
  readonly summary: string;
  readonly rawOutput: unknown;
  readonly findings: unknown;

  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Sum of every LLM call's latency (total compute time). */
  readonly latencyMs: number;
  /**
   * Wall-clock lower bound when independent calls run in parallel: the sum over
   * sequential rounds of the slowest call in each round (B3). Equals
   * `latencyMs` for single-call architectures. Optional so existing carriers
   * default to the sum when a topology does not report it.
   */
  readonly criticalPathLatencyMs?: number;
  readonly estimatedCostUsd: number;
  /** Number of inter-agent messages (0/1 for single-agent architectures). */
  readonly messageCount: number;
  /** Number of LLM provider calls made during execution (RFC-04). */
  readonly llmCalls: number;
  /**
   * How many of this run's LLM calls were cut off by the output-token cap (B2).
   * A truncated call can silently drop findings; tracking it separates a
   * token-budget recall loss from a topology effect. Optional so carriers
   * default to 0 when unreported.
   */
  readonly truncatedCallCount?: number;
}

/**
 * The structured, schema-valid result produced by the Validation Engine
 * (RFC-05). Unlike {@link RawReviewResult}, this is guaranteed to satisfy the
 * project schema. Execution metrics are carried through from the raw result,
 * and `validation` records how it was validated/normalized.
 */
export interface ValidatedReviewResult {
  readonly architecture: ReviewArchitecture;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly validation: ValidationMetadata;

  readonly latencyMs: number;
  /** See {@link RawReviewResult.criticalPathLatencyMs}. */
  readonly criticalPathLatencyMs?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  /** See {@link RawReviewResult.truncatedCallCount}. */
  readonly truncatedCallCount?: number;
}
