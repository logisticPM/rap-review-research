/**
 * Severity / risk classification shared by findings and review results.
 *
 * Defined as a string-literal union (per the Development Guidelines, which
 * prefer unions over enums) so the values survive native TypeScript type
 * stripping and remain a single source of truth.
 */
export type SeverityLevel = "low" | "medium" | "high" | "critical";

/** A review result's overall risk level uses the same scale as a finding's severity. */
export type RiskLevel = SeverityLevel;

/**
 * A single issue surfaced by a review architecture.
 *
 * This is the *review-time* shape of a finding (the data an architecture
 * produces). The persisted `Finding` entity (with `findingId` / `experimentId`)
 * is owned by the Storage Engine RFC and is intentionally not modelled here.
 *
 * Findings are immutable once validated.
 */
export interface ReviewFinding {
  /**
   * Stable identifier for the finding. Assigned by the Validation Engine
   * (RFC-05) — deterministic, not model-invented.
   */
  readonly id: string;
  /** Short human-readable title for the issue. */
  readonly title: string;
  /** Issue category (e.g. "security", "performance", "correctness"). */
  readonly category: string;
  /** Severity of the issue. */
  readonly severity: SeverityLevel;
  /** Path of the file the finding refers to. */
  readonly file: string;
  /** Line number within the file. */
  readonly line: number;
  /**
   * The offending line(s) quoted verbatim from the diff (A3). LLMs count diff
   * lines unreliably, so a snippet lets the evaluator re-anchor a finding to the
   * right line by locating it in the hunk, making localization measure
   * understanding rather than arithmetic. Optional: absent on older data and on
   * models that omit it (matching then falls back to `line`).
   */
  readonly snippet?: string;
  /** Explanation of the issue. */
  readonly description: string;
  /** Suggested remediation. */
  readonly recommendation: string;
  /** Model-reported confidence in the finding, in the range [0, 1]. */
  readonly confidence: number;
}
