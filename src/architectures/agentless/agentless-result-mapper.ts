import type { LLMReviewResponse } from "../../llm/models/llm-review-response.ts";
import type { RawReviewResult } from "../../models/review-result.ts";

import { isTruncatedStopReason } from "../../llm/models/llm-review-response.ts";

/** Agentless makes exactly one LLM provider call per review. */
export const AGENTLESS_LLM_CALLS = 1;

/** Agentless is single-agent, so there are no inter-agent messages. */
const AGENTLESS_MESSAGE_COUNT = 1;

/**
 * Map an {@link LLMReviewResponse} into a {@link RawReviewResult}.
 *
 * This performs **no validation**: it does a tolerant, best-effort surfacing of
 * `summary`/`findings` from JSON-shaped output and never throws or enforces a
 * schema. The unmodified model text is preserved in `rawOutput` so the
 * Validation Engine (RFC-05) can validate it later.
 */
export function mapToRawReviewResult(
  response: LLMReviewResponse,
): RawReviewResult {
  const { summary, findings } = surface(response.text);
  return {
    architecture: "agentless",
    summary,
    findings,
    rawOutput: response.text,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    latencyMs: response.latencyMs,
    estimatedCostUsd: response.estimatedCostUsd,
    messageCount: AGENTLESS_MESSAGE_COUNT,
    llmCalls: AGENTLESS_LLM_CALLS,
    truncatedCallCount: isTruncatedStopReason(response.stopReason) ? 1 : 0,
  };
}

/** Best-effort extraction — NOT validation. Never throws. */
function surface(text: string): { summary: string; findings: unknown } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return {
        summary: typeof record.summary === "string" ? record.summary : "",
        findings: "findings" in record ? record.findings : [],
      };
    }
  } catch {
    // Non-JSON output is left untouched in rawOutput for the Validation Engine.
  }
  return { summary: "", findings: [] };
}
