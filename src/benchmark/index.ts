/**
 * Public barrel for Benchmark Dataset & Ground-Truth Evaluation (RFC-13).
 *
 * Evaluates Agentless / Hierarchical / Consensus against external PR-review
 * datasets with ground truth: adapters load datasets, the importer/runner drive
 * the existing pipeline (every instance reviewed by all three architectures),
 * and the ground-truth evaluator computes precision/recall/F1/localization.
 * Deterministic and LLM-free (semantic matching is a placeholder).
 */

// Models.
export type { GroundTruthIssue } from "./models/ground-truth-issue.ts";
export type {
  BenchmarkDataset,
  BenchmarkSource,
} from "./models/benchmark-dataset.ts";
export type { BenchmarkInstance } from "./models/benchmark-instance.ts";
export type { BenchmarkRun } from "./models/benchmark-run.ts";
export type {
  BenchmarkResult,
  BenchmarkArchitectureSummary,
} from "./models/benchmark-result.ts";

// Adapters.
export type { IBenchmarkDatasetAdapter } from "./adapters/dataset-adapter.ts";
export { normalizeSeverity } from "./adapters/normalize-severity.ts";
export type {
  QodoRawDataset,
  QodoRawRow,
  QodoRawIssue,
} from "./adapters/qodo-pr-review-bench-adapter.ts";
export { QodoPRReviewBenchAdapter } from "./adapters/qodo-pr-review-bench-adapter.ts";
export type {
  SWEPRBenchDataset,
  SWEPRBenchInstance,
  SWEPRBenchReviewComment,
} from "./adapters/swe-prbench-adapter.ts";
export { SWEPRBenchAdapter } from "./adapters/swe-prbench-adapter.ts";

// Matching.
export type {
  MatchResult,
  IssueMatcherOptions,
} from "./matching/issue-matcher.ts";
export { IssueMatcher } from "./matching/issue-matcher.ts";
export type { ISemanticMatcher } from "./matching/semantic-matcher.ts";
export { NoopSemanticMatcher } from "./matching/semantic-matcher.ts";
export { maxBipartiteMatching } from "./matching/bipartite-matcher.ts";
export type { JudgeConfig } from "./matching/judge-prompt.ts";
export {
  buildJudgePrompt,
  parseJudgeScore,
  DEFAULT_JUDGE_CONFIG,
} from "./matching/judge-prompt.ts";
export { pairKey, SemanticScoreCache } from "./matching/semantic-score-cache.ts";
export { CachedSemanticMatcher } from "./matching/cached-semantic-matcher.ts";
export { JudgeScorePrecomputer } from "./matching/judge-score-precomputer.ts";

// Evaluation.
export type { GroundTruthEvaluatorDependencies } from "./ground-truth-evaluator.ts";
export { GroundTruthEvaluator } from "./ground-truth-evaluator.ts";
export type { BenchmarkEvaluatorDependencies } from "./benchmark-evaluator.ts";
export { BenchmarkEvaluator } from "./benchmark-evaluator.ts";

// Resume (Phase 2 instance-level budget saver).
export type { InstanceResumePlan } from "./resume-plan.ts";
export { planInstanceResume } from "./resume-plan.ts";

// Import + run.
export type {
  ImportedBenchmarkInstance,
  ImportOptions,
} from "./benchmark-importer.ts";
export { BenchmarkImporter } from "./benchmark-importer.ts";
export type {
  BenchmarkExecutionConfig,
  BenchmarkRunnerDependencies,
} from "./benchmark-runner.ts";
export { BenchmarkRunner } from "./benchmark-runner.ts";

// Export.
export type { BenchmarkExportRow } from "./export/benchmark-export-row.ts";
export {
  BENCHMARK_STABLE_COLUMNS,
  toBenchmarkExportRows,
} from "./export/benchmark-export-row.ts";
export type { BenchmarkExportResult } from "./export/benchmark-csv-exporter.ts";
export {
  BenchmarkCsvExporter,
  benchmarkResultsToCsv,
} from "./export/benchmark-csv-exporter.ts";

// Errors.
export {
  BenchmarkError,
  DatasetAdapterError,
  BenchmarkRunError,
} from "./benchmark-errors.ts";
