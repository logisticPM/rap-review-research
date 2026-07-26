import type { StoredExperimentResult } from "../storage/stored-models.ts";
import type { OperationalCostMetrics } from "./models/experiment-metrics.ts";

/**
 * Copies operational-cost metrics from a stored experiment.
 *
 * These values are collected during execution and are passed through
 * unchanged (no derived calculations). Prefers the validated result; falls back
 * to the raw result; zeros if neither is present. Pure and deterministic.
 */
export class CostMetricsCalculator {
  public calculate(result: StoredExperimentResult): OperationalCostMetrics {
    const source = result.validatedResult ?? result.rawResult;
    return {
      latencyMs: source?.latencyMs ?? 0,
      // Fall back to the sum when a topology reports no critical path (e.g.
      // single-call agentless), so the column is always populated.
      criticalPathLatencyMs:
        source?.criticalPathLatencyMs ?? source?.latencyMs ?? 0,
      truncatedCallCount: source?.truncatedCallCount ?? 0,
      inputTokens: source?.inputTokens ?? 0,
      outputTokens: source?.outputTokens ?? 0,
      estimatedCostUsd: source?.estimatedCostUsd ?? 0,
      llmCalls: source?.llmCalls ?? 0,
      messageCount: source?.messageCount ?? 0,
    };
  }
}
