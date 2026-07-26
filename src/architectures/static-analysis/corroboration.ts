import type { ReviewFinding } from "../../models/finding.ts";

/**
 * Cross-SOURCE corroboration between an LLM member's findings and a
 * static-analysis member's findings. Agreement is LOCATION-based (same file,
 * line within a tolerance) rather than title/text-based, because the two sources
 * phrase the same issue very differently — what matters is that two INDEPENDENT
 * information sources flagged the same spot. LLM∩tool agreement is the precision
 * signal (a finding both a model and a deterministic analyzer point at is far
 * more likely real than one only a model asserts).
 */
function normFile(file: string): string {
  return file.trim().replace(/^\.\//, "").replace(/^[ab]\//, "");
}

export interface CorroborationResult {
  /** LLM findings backed by ≥1 nearby static finding (the high-precision subset). */
  readonly corroborated: ReviewFinding[];
  /** LLM findings with no nearby static finding. */
  readonly llmOnly: ReviewFinding[];
  /** Static findings with no nearby LLM finding (deterministic-only coverage). */
  readonly staticOnly: ReviewFinding[];
}

export function crossSourceCorroborate(
  llmFindings: readonly ReviewFinding[],
  staticFindings: readonly ReviewFinding[],
  lineTolerance = 2,
): CorroborationResult {
  const near = (a: ReviewFinding, b: ReviewFinding): boolean =>
    normFile(a.file) === normFile(b.file) && Math.abs(a.line - b.line) <= lineTolerance;

  return {
    corroborated: llmFindings.filter((l) => staticFindings.some((s) => near(l, s))),
    llmOnly: llmFindings.filter((l) => !staticFindings.some((s) => near(l, s))),
    staticOnly: staticFindings.filter((s) => !llmFindings.some((l) => near(l, s))),
  };
}
