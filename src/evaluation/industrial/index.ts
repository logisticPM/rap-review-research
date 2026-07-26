/**
 * Public barrel for the Industrial Verification layer (RAP Portal case study,
 * experiment E3). Additive to RFC-07: corroborates AI findings without ground
 * truth via cross-architecture agreement, static-analysis agreement, LLM-judge
 * validation, and later-fix rate. See docs/experiments/02-benchmark-selection.md §6.
 */
export type {
  ArchitectureFindings,
  StaticAnalysisFinding,
  FindingVerdict,
  ChangedRange,
  IndustrialVerificationContext,
  IndustrialVerificationSignals,
} from "./models.ts";

export {
  FindingSimilarity,
  type FindingSimilarityOptions,
} from "./finding-similarity.ts";
export {
  ArchitectureAgreementCalculator,
  type ArchitectureAgreementResult,
} from "./architecture-agreement.ts";
export { StaticAnalysisAgreementCalculator } from "./static-analysis-agreement.ts";
export { LlmJudgeValidationCalculator } from "./llm-judge-validation.ts";
export { LaterFixRateCalculator } from "./later-fix-rate.ts";
export {
  IndustrialVerification,
  type IndustrialVerificationDependencies,
} from "./industrial-verification.ts";
