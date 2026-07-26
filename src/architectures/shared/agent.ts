/**
 * Shared multi-agent primitives, used by both the Hierarchical (RFC-08) and
 * Consensus (RFC-09) architectures so neither depends on the other.
 */

/**
 * Agent roles across the multi-agent architectures. `manager` orchestrates in
 * Hierarchical (RFC-08); `coordinator` schedules (non-authoritatively) in
 * Consensus (RFC-09); the rest are specialist reviewers.
 */
export type AgentRole =
  | "manager"
  | "coordinator"
  | "backend"
  | "frontend"
  | "database"
  | "generalist";

/**
 * Message types exchanged between agents. A superset covering both topologies:
 * hierarchical (`review-*`, `merge-*`) and consensus (`exchange`, `revision-*`,
 * `vote-*`, `synthesis`).
 */
export type AgentMessageType =
  | "review-request"
  | "review-response"
  | "merge-request"
  | "merge-response"
  | "exchange"
  | "revision-request"
  | "revision-response"
  | "vote-request"
  | "vote-response"
  | "synthesis";

/**
 * A strongly-typed message between agents. Raw strings are never passed between
 * agents — this improves replayability and future visualization.
 */
export interface AgentMessage {
  readonly from: AgentRole;
  readonly to: AgentRole;
  readonly type: AgentMessageType;
  readonly content: unknown;
  readonly timestamp: string;
}
