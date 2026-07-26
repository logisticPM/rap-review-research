import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { ReviewFinding } from "../../models/finding.ts";
import type { ResearchEvidenceMetrics } from "../models/experiment-metrics.ts";

/**
 * Inputs and outputs for the Industrial Verification layer (RAP Portal case
 * study, experiment E3). The RAP Portal has no authoritative ground truth and
 * few human review comments, so correctness cannot be measured directly.
 * Instead, AI findings are *corroborated* by automated, reproducible signals:
 * cross-architecture agreement, agreement with static analysis, and an
 * independent LLM judge. Everything here is additive and optional — it never
 * participates in the Qodo/SWE ground-truth benchmark path.
 */

/** One architecture's findings for a single PR, the unit of cross-architecture agreement. */
export interface ArchitectureFindings {
  readonly architecture: ReviewArchitecture;
  readonly findings: ReviewFinding[];
}

/**
 * An issue reported by a conventional static analysis tool (linter, type
 * checker, SAST) on the reviewed PR. Used as an automated *corroboration
 * reference*, NOT authoritative ground truth: static analyzers have their own
 * false positives and coverage gaps, so overlap raises confidence but its
 * absence proves nothing.
 */
export interface StaticAnalysisFinding {
  readonly file: string;
  readonly line: number;
  /** Tool rule id (e.g. an ESLint rule), when available. */
  readonly rule?: string;
  /** Issue category (e.g. "security"), when the tool provides one. */
  readonly category?: string;
}

/**
 * An independent LLM judge's verdict on a single AI finding, given the PR diff.
 * The judge is a *supporting corroboration* signal (it can share biases with the
 * reviewer models), never authoritative ground truth.
 */
export type FindingVerdict = "valid" | "invalid" | "uncertain";

/**
 * A line range that was modified by a *later* commit than the reviewed PR.
 * Overlap between a finding's location and a later change is weak external
 * evidence that the finding pointed at code that genuinely needed attention.
 */
export interface ChangedRange {
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/**
 * Optional external evidence for one PR's industrial verification. Any field may
 * be omitted — the corresponding metric is then simply left `undefined` (never
 * an error), keeping the whole layer backward compatible. The heavy producers
 * (running static analysis, calling the LLM judge, mining later commits) live
 * outside the pure Evaluation Engine and feed their results in here.
 */
export interface IndustrialVerificationContext {
  readonly staticAnalysisFindings?: StaticAnalysisFinding[];
  /** LLM-judge verdicts keyed by `ReviewFinding.id`. */
  readonly judgeVerdicts?: Readonly<Record<string, FindingVerdict>>;
  readonly laterChanges?: ChangedRange[];
}

/**
 * The industrial-verification signals for one architecture on one PR — a subset
 * of {@link ResearchEvidenceMetrics}. Merged into an experiment's
 * `researchEvidence` by the Evaluation Engine, alongside the existing
 * (supporting-heuristic) `evidenceScore`.
 */
export type IndustrialVerificationSignals = Partial<
  Pick<
    ResearchEvidenceMetrics,
    | "architectureAgreement"
    | "staticAnalysisAgreement"
    | "llmJudgeValidation"
    | "laterFixRate"
  >
>;
