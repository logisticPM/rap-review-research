import type { AgentRole } from "./agent.ts";
import type { ReviewFinding } from "../../models/finding.ts";

/**
 * A single specialist's review output, shared across the multi-agent
 * architectures. Preserved for replay/visualization.
 */
export interface SpecialistReviewResult {
  readonly role: AgentRole;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** This call was cut off by the output-token cap (B2). Optional/defaults false. */
  readonly truncated?: boolean;
}
