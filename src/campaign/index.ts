/**
 * Public barrel for the Experiment Campaign Runner.
 *
 * An orchestration layer that executes an entire benchmark campaign — every
 * instance reviewed by Agentless, Hierarchical, and Consensus — reusing the
 * existing Import, Experiment, Validation, Storage, Evaluation, Export, and
 * Benchmark services **without modifying them**. It tracks progress, records a
 * reproducible manifest, retries transient failures, resumes interrupted runs,
 * summarizes, and exports campaign-level CSV/JSON.
 *
 * Methodology: docs/experiment/01-experiment-plan.md, 02-benchmark-selection.md,
 * 03-runbook.md. The campaign defines no new metrics.
 */

export type {
  CampaignConfig,
  CampaignRunnerDependencies,
  CampaignExports,
  CampaignReport,
} from "./campaign-runner.ts";
export { CampaignRunner, BENCHMARK_ARCHITECTURES } from "./campaign-runner.ts";

export type { LoadedInstance } from "./benchmark-loader.ts";
export { BenchmarkLoader } from "./benchmark-loader.ts";

export type {
  ManifestStatus,
  ManifestEntry,
  CampaignManifestData,
  ManifestProgress,
  ManifestStore,
} from "./manifest.ts";
export { Manifest, manifestEntryKey, InMemoryManifestStore } from "./manifest.ts";

export type {
  ExecutionVersions,
  ExecutionInput,
  ExecutionOutcome,
  IExperimentExecutor,
  ExperimentExecutorDependencies,
} from "./experiment-executor.ts";
export { ExperimentExecutor } from "./experiment-executor.ts";

export { RetryPolicy } from "./retry-policy.ts";

export type {
  LogSink,
  ProgressReporterOptions,
} from "./progress-reporter.ts";
export { ProgressReporter } from "./progress-reporter.ts";

export type {
  CampaignSummary,
  DatasetCoverage,
  CampaignFailure,
  ArchitectureTruncation,
  BuildCampaignSummaryInput,
} from "./campaign-summary.ts";
export { buildCampaignSummary } from "./campaign-summary.ts";
