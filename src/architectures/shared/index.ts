/**
 * Public barrel for shared multi-agent primitives (used by RFC-08 and RFC-09).
 */
export type { AgentRole, AgentMessageType, AgentMessage } from "./agent.ts";
export { ConversationHistory } from "./conversation-history.ts";
export type { SpecialistReviewResult } from "./specialist-review-result.ts";
export {
  LlmReviewSpecialist,
  parseSpecialistReview,
  toReviewFinding,
} from "./review-specialist.ts";
export type {
  IReviewSpecialist,
  ReviewSpecialistDependencies,
  SpecialistConfig,
} from "./review-specialist.ts";
export type { FindingDedupOptions, FindingLocus } from "./finding-dedup.ts";
export { areDuplicateFindings } from "./finding-dedup.ts";
