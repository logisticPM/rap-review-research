import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { ExperimentMetrics } from "./experiment-metrics.ts";

/**
 * A flat, export-ready record for one experiment (one row per experiment).
 *
 * The Evaluation Engine only prepares these rows — writing CSV/JSON files
 * belongs to a future Export Service.
 */
export interface EvaluationExportRow {
  readonly experimentId: string;
  readonly architecture: ReviewArchitecture;
  readonly findingCount: number;
  readonly highSeverityCount: number;
  readonly criticalSeverityCount: number;
  readonly averageConfidence: number;
  readonly latencyMs: number;
  readonly criticalPathLatencyMs: number;
  readonly truncatedCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  /** Supporting heuristic (severity + confidence + volume), NOT a correctness metric. */
  readonly evidenceScore: number;
  /** Industrial-verification signals (RAP Portal); present only when computed. */
  readonly architectureAgreement?: number;
  readonly staticAnalysisAgreement?: number;
  readonly llmJudgeValidation?: number;
  readonly laterFixRate?: number;
}

/**
 * Flatten {@link ExperimentMetrics} into a single export row. Pure and
 * deterministic; does not mutate the input.
 */
export function toEvaluationExportRow(
  metrics: ExperimentMetrics,
): EvaluationExportRow {
  return {
    experimentId: metrics.experimentId,
    architecture: metrics.architecture,
    findingCount: metrics.reviewQuality.findingCount,
    highSeverityCount: metrics.reviewQuality.highSeverityCount,
    criticalSeverityCount: metrics.reviewQuality.criticalSeverityCount,
    averageConfidence: metrics.reviewQuality.averageConfidence,
    latencyMs: metrics.operationalCost.latencyMs,
    criticalPathLatencyMs: metrics.operationalCost.criticalPathLatencyMs,
    truncatedCallCount: metrics.operationalCost.truncatedCallCount,
    inputTokens: metrics.operationalCost.inputTokens,
    outputTokens: metrics.operationalCost.outputTokens,
    estimatedCostUsd: metrics.operationalCost.estimatedCostUsd,
    llmCalls: metrics.operationalCost.llmCalls,
    messageCount: metrics.operationalCost.messageCount,
    evidenceScore: metrics.researchEvidence.evidenceScore,
    architectureAgreement: metrics.researchEvidence.architectureAgreement,
    staticAnalysisAgreement: metrics.researchEvidence.staticAnalysisAgreement,
    llmJudgeValidation: metrics.researchEvidence.llmJudgeValidation,
    laterFixRate: metrics.researchEvidence.laterFixRate,
  };
}
