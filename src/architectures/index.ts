/**
 * Public barrel for the review-architecture layer.
 */
export type {
  IReviewArchitecture,
  ArchitectureRegistry,
} from "./review-architecture.ts";

export { InMemoryArchitectureRegistry } from "./in-memory-architecture-registry.ts";
export { MockReviewArchitecture } from "./mock/mock-review-architecture.ts";
export type { MockReviewArchitectureOptions } from "./mock/mock-review-architecture.ts";

export { AgentlessArchitecture } from "./agentless/index.ts";
export type { AgentlessArchitectureDependencies } from "./agentless/index.ts";

export {
  HierarchicalArchitecture,
  createHierarchicalArchitecture,
} from "./hierarchical/index.ts";
export type { HierarchicalArchitectureDependencies } from "./hierarchical/index.ts";

export {
  ConsensusArchitecture,
  createConsensusArchitecture,
} from "./consensus/index.ts";
export type { ConsensusArchitectureDependencies } from "./consensus/index.ts";

export {
  GeneralistsArchitecture,
  createGeneralistsArchitecture,
} from "./generalists/index.ts";
export type { GeneralistsArchitectureDependencies } from "./generalists/index.ts";

// Offline replay of deterministic synthesis from persisted artifacts (B1).
export {
  replayHierarchicalFindings,
  replayConsensusFindings,
} from "./replay.ts";
