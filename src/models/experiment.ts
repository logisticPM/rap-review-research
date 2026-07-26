/**
 * Lifecycle states of an experiment.
 *
 * The ordering of the happy path is:
 *   created → queued → running → validating → evaluating → completed
 * with `failed` reachable from any executing state.
 */
export type ExperimentStatus =
  | "created"
  | "queued"
  | "running"
  | "validating"
  | "evaluating"
  | "completed"
  | "failed";

/**
 * The communication topology under test — the single independent variable of
 * the research. New topologies are added as plugins without changing the
 * Experiment Engine.
 */
export type ReviewArchitecture =
  | "agentless"
  | "hierarchical"
  | "consensus"
  | "generalists-3";

/**
 * The primary entity of the platform.
 *
 * An experiment represents a single execution of one review architecture
 * against one immutable PR Snapshot. Only the execution `status` and the
 * execution-metadata fields may change after creation; all identity fields are
 * effectively immutable.
 */
export interface Experiment {
  readonly experimentId: string;
  readonly snapshotId: string;
  readonly architecture: ReviewArchitecture;

  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly workflowVersion: string;
  readonly evaluationVersion: string;

  status: ExperimentStatus;

  readonly createdAt: string;
  startedAt?: string;
  completedAt?: string;

  totalLatencyMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  estimatedCostUsd?: number;

  errorMessage?: string;
}

/**
 * Input to {@link IExperimentEngine.run}.
 */
export interface RunExperimentInput {
  readonly snapshotId: string;
  readonly architecture: ReviewArchitecture;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly workflowVersion: string;
  readonly evaluationVersion: string;
  /** When true, always create a new versioned experiment instead of reusing. */
  readonly forceRerun?: boolean;
}

/**
 * Result returned by {@link IExperimentEngine.run} / {@link IExperimentEngine.retry}.
 */
export interface RunExperimentResult {
  readonly experimentId: string;
  readonly status: ExperimentStatus;
  /** True when an existing experiment was returned without re-executing. */
  readonly reusedExisting: boolean;
  /** On a failed status, the underlying error message (so callers can classify
   * transient vs terminal — e.g. throttling should be retried). */
  readonly error?: string;
}

/**
 * Execution-level summary applied when an experiment completes.
 *
 * These are the metrics owned by the Experiment Engine (timing, tokens, cost,
 * message count). Research metrics such as precision/recall are computed by the
 * Evaluation Engine (a future RFC) and are intentionally absent here.
 */
export interface ExperimentCompletionSummary {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly totalLatencyMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly estimatedCostUsd: number;
  readonly messageCount: number;
}
