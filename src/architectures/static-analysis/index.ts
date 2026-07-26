/**
 * Tier-1 static-analysis reviewer — a deterministic, non-LLM heterogeneous review
 * member (proof-of-concept for tool-grounded / "true heterogeneity" review). It
 * emits {@link ReviewFinding}s in the shared schema so it composes with the LLM
 * architectures and cross-corroborates with their findings.
 */
export type { AddedLine } from "./added-lines.ts";
export { parseAddedLines } from "./added-lines.ts";
export type { StaticRule } from "./rules.ts";
export { DEFAULT_RULES } from "./rules.ts";
export { StaticAnalysisReviewer } from "./static-analysis-reviewer.ts";
export type { CorroborationResult } from "./corroboration.ts";
export { crossSourceCorroborate } from "./corroboration.ts";
