/**
 * A provider-independent LLM response, with the execution metrics every
 * provider must report.
 *
 * Provider-specific payloads (e.g. a Bedrock Converse response) are mapped into
 * this shape. `modelId` records the model that actually served the request —
 * useful when the requested id is an inference profile or alias.
 */
export interface LLMReviewResponse {
  readonly text: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly estimatedCostUsd: number;
  /**
   * Why generation stopped, as reported by the provider (Bedrock Converse:
   * "end_turn" | "max_tokens" | "stop_sequence" | ...). Undefined when the
   * provider does not report one. Used to detect truncation (B2).
   */
  readonly stopReason?: string;
}

/**
 * True when a response was cut off by the output-token cap (B2). A truncated
 * review can silently lose findings, so on large PRs an architecture with a
 * single completion (agentless) may show lower recall for a token-budget
 * reason rather than a topology one — hence we count it per experiment.
 */
export function isTruncatedStopReason(stopReason: string | undefined): boolean {
  return stopReason === "max_tokens";
}
