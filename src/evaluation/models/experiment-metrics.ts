import type { ReviewArchitecture } from "../../models/experiment.ts";

/**
 * Review-quality metrics derived from a completed experiment's findings.
 *
 * `localizationAccuracy` is only meaningful in synthetic-benchmark mode (known
 * defect locations); it is left undefined for real pull requests.
 */
export interface ReviewQualityMetrics {
  readonly findingCount: number;
  readonly lowSeverityCount: number;
  readonly mediumSeverityCount: number;
  readonly highSeverityCount: number;
  readonly criticalSeverityCount: number;
  readonly averageConfidence: number;
  readonly duplicateFindingCount: number;
  readonly localizationAccuracy?: number;
}

/**
 * Operational-cost metrics. These are collected directly from the experiment
 * execution — the calculator copies them through without modification.
 */
export interface OperationalCostMetrics {
  readonly latencyMs: number;
  /**
   * Wall-clock lower bound with parallel intra-round dispatch (B3). Falls back
   * to `latencyMs` for architectures that do not report a critical path.
   */
  readonly criticalPathLatencyMs: number;
  /** How many LLM calls were cut off by the output-token cap (B2). */
  readonly truncatedCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
}

/**
 * Research-evidence metrics.
 *
 * `evidenceScore` is a *supporting heuristic* (severity + confidence + volume of
 * self-reported findings), NOT a correctness measure — a confidently wrong
 * finding still scores high. It is always present.
 *
 * The remaining signals are the industrial-verification metrics for the RAP
 * Portal case study (experiment E3), which has no authoritative ground truth.
 * They are optional and populated by {@link EvaluationEngine.evaluateIndustrial}
 * only when computable (`architectureAgreement` needs ≥2 architectures;
 * `staticAnalysisAgreement` / `llmJudgeValidation` / `laterFixRate` need external
 * evidence). Missing optional values must never fail evaluation and are omitted.
 */
export interface ResearchEvidenceMetrics {
  readonly evidenceScore: number;
  /** Cross-architecture agreement: fraction of this architecture's findings also
   *  found by ≥1 other architecture on the same PR (corroboration). */
  readonly architectureAgreement?: number;
  /** Fraction of findings coinciding with a static-analysis issue (corroboration,
   *  NOT ground truth). */
  readonly staticAnalysisAgreement?: number;
  /** Fraction of findings an independent LLM judge classified as valid (supporting
   *  corroboration, NOT ground truth). */
  readonly llmJudgeValidation?: number;
  /** Reserved: fraction of findings accepted by a human reviewer. */
  readonly acceptedFindingRate?: number;
  /** Fraction of findings whose location was modified by a later commit. */
  readonly laterFixRate?: number;
}

/**
 * The primary output of the Evaluation Engine for a single experiment.
 */
export interface ExperimentMetrics {
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly reviewQuality: ReviewQualityMetrics;
  readonly operationalCost: OperationalCostMetrics;
  readonly researchEvidence: ResearchEvidenceMetrics;
}
