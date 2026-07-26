/**
 * Public barrel for the Research Evaluation Engine (RFC-07).
 */
export type {
  IEvaluationEngine,
  EvaluationEngineDependencies,
} from "./evaluation-engine.ts";
export { EvaluationEngine, createEvaluationEngine } from "./evaluation-engine.ts";

export { FindingMetricsCalculator } from "./finding-metrics.ts";
export { CostMetricsCalculator } from "./cost-metrics.ts";
export { EvidenceMetricsCalculator } from "./evidence-metrics.ts";
export { ComparisonEngine } from "./comparison-engine.ts";

export type { IEvidenceScorer } from "./scorers/evidence-scorer.ts";
export { HeuristicEvidenceScorer } from "./scorers/heuristic-evidence-scorer.ts";

export {
  EvaluationError,
  MetricCalculationError,
  ComparisonError,
} from "./evaluation-errors.ts";

export type {
  ExperimentMetrics,
  ReviewQualityMetrics,
  OperationalCostMetrics,
  ResearchEvidenceMetrics,
} from "./models/experiment-metrics.ts";
export type { ExperimentComparison } from "./models/experiment-comparison.ts";
export type { EvaluationExportRow } from "./models/evaluation-export-row.ts";
export { toEvaluationExportRow } from "./models/evaluation-export-row.ts";

// Industrial Verification (RAP Portal case study, experiment E3). Additive.
export type {
  ArchitectureFindings,
  StaticAnalysisFinding,
  FindingVerdict,
  ChangedRange,
  IndustrialVerificationContext,
  IndustrialVerificationSignals,
  FindingSimilarityOptions,
  ArchitectureAgreementResult,
  IndustrialVerificationDependencies,
} from "./industrial/index.ts";
export {
  FindingSimilarity,
  ArchitectureAgreementCalculator,
  StaticAnalysisAgreementCalculator,
  LlmJudgeValidationCalculator,
  LaterFixRateCalculator,
  IndustrialVerification,
} from "./industrial/index.ts";
