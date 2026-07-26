import type { ReviewArchitecture } from "../models/experiment.ts";
import type { ReviewFinding } from "../models/finding.ts";
import type { ValidationMetadata } from "../models/validation-metadata.ts";

/**
 * Persisted forms of experiment artifacts (RFC-06). These are the storage-layer
 * projections of the domain review results, each stamped with `storedAt`. They
 * live in the storage module (not `models/`) because they are persistence
 * concerns, not domain entities.
 */

/** A raw architecture result, preserved exactly as received. */
export interface StoredRawReviewResult {
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly rawOutput: unknown;
  readonly summary: string;
  readonly findings: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly criticalPathLatencyMs?: number;
  readonly truncatedCallCount?: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  readonly storedAt: string;
}

/** A validated result, persisted only after validation succeeds. */
export interface StoredValidatedReviewResult {
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly validation: ValidationMetadata;
  readonly latencyMs: number;
  readonly criticalPathLatencyMs?: number;
  readonly truncatedCallCount?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  readonly storedAt: string;
}

/** A finding, stored individually so it can be queried/exported/evaluated. */
export interface StoredReviewFinding extends ReviewFinding {
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly storedAt: string;
}

/** The composed view of everything stored for one experiment. */
export interface StoredExperimentResult {
  readonly experimentId: string;
  readonly rawResult: StoredRawReviewResult | null;
  readonly validatedResult: StoredValidatedReviewResult | null;
  readonly findings: StoredReviewFinding[];
}
