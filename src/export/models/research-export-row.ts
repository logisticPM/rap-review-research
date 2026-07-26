import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { ExperimentComparison } from "../../evaluation/models/experiment-comparison.ts";

/**
 * A flat, research-ready row: one architecture's metrics for one compared
 * snapshot. Optional evidence signals are `undefined` until later RFCs populate
 * them (rendered as empty strings in CSV).
 */
export interface ResearchExportRow {
  readonly snapshotId: string;
  readonly architecture: ReviewArchitecture;
  readonly findingCount: number;
  readonly lowSeverityCount: number;
  readonly mediumSeverityCount: number;
  readonly highSeverityCount: number;
  readonly criticalSeverityCount: number;
  readonly averageConfidence: number;
  readonly duplicateFindingCount: number;
  readonly latencyMs: number;
  readonly criticalPathLatencyMs: number;
  readonly truncatedCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly llmCalls: number;
  readonly messageCount: number;
  /** Supporting heuristic (severity + confidence + volume), NOT correctness. */
  readonly evidenceScore: number;
  readonly architectureAgreement?: number;
  readonly acceptedFindingRate?: number;
  readonly laterFixRate?: number;
  /** Industrial-verification corroboration signals (RAP Portal). */
  readonly staticAnalysisAgreement?: number;
  readonly llmJudgeValidation?: number;
}

/**
 * Stable CSV column order. These names are used by paper scripts and must not
 * be renamed once the experiment freeze begins. Kept in lockstep with
 * {@link ResearchExportRow} keys.
 */
export const STABLE_COLUMNS: readonly (keyof ResearchExportRow)[] = [
  "snapshotId",
  "architecture",
  "findingCount",
  "lowSeverityCount",
  "mediumSeverityCount",
  "highSeverityCount",
  "criticalSeverityCount",
  "averageConfidence",
  "duplicateFindingCount",
  "latencyMs",
  "criticalPathLatencyMs",
  "truncatedCallCount",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "llmCalls",
  "messageCount",
  "evidenceScore",
  "architectureAgreement",
  "acceptedFindingRate",
  "laterFixRate",
  "staticAnalysisAgreement",
  "llmJudgeValidation",
];

/**
 * Flatten comparisons into one row per architecture per comparison. Pure; does
 * not compute any metrics — it only projects the RFC-07 evaluation output.
 */
export function toResearchExportRows(
  comparisons: ExperimentComparison[],
): ResearchExportRow[] {
  const rows: ResearchExportRow[] = [];
  for (const comparison of comparisons) {
    for (const metrics of comparison.architectures) {
      rows.push({
        snapshotId: comparison.experimentId,
        architecture: metrics.architecture,
        findingCount: metrics.reviewQuality.findingCount,
        lowSeverityCount: metrics.reviewQuality.lowSeverityCount,
        mediumSeverityCount: metrics.reviewQuality.mediumSeverityCount,
        highSeverityCount: metrics.reviewQuality.highSeverityCount,
        criticalSeverityCount: metrics.reviewQuality.criticalSeverityCount,
        averageConfidence: metrics.reviewQuality.averageConfidence,
        duplicateFindingCount: metrics.reviewQuality.duplicateFindingCount,
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
        acceptedFindingRate: metrics.researchEvidence.acceptedFindingRate,
        laterFixRate: metrics.researchEvidence.laterFixRate,
        staticAnalysisAgreement: metrics.researchEvidence.staticAnalysisAgreement,
        llmJudgeValidation: metrics.researchEvidence.llmJudgeValidation,
      });
    }
  }
  return rows;
}
