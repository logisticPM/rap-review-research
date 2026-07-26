import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { ISemanticMatcher } from "./semantic-matcher.ts";

import { NoopSemanticMatcher } from "./semantic-matcher.ts";

/**
 * The outcome of comparing one produced finding to one ground-truth issue.
 *
 * `matched` is the primary predicate used for precision/recall: an exact file
 * match plus a line-range overlap (line overlap can be relaxed via options).
 * `categoryMatch`/`severityMatch` are only defined when *both* sides carry the
 * attribute (they inform analysis but never gate `matched` unless required).
 * `semanticScore` is populated only by a real semantic matcher — the default is
 * `undefined` (placeholder, no LLM).
 */
export interface MatchResult {
  readonly matched: boolean;
  readonly fileMatch: boolean;
  readonly lineOverlap: boolean;
  readonly categoryMatch?: boolean;
  readonly severityMatch?: boolean;
  readonly semanticScore?: number;
}

export interface IssueMatcherOptions {
  /** Require the finding's line to fall inside the issue's span. Default true. */
  readonly requireLineOverlap?: boolean;
  /** Also require category equality when both sides have one. Default false. */
  readonly requireCategoryMatch?: boolean;
  /** Also require severity equality when both sides have one. Default false. */
  readonly requireSeverityMatch?: boolean;
  readonly semanticMatcher?: ISemanticMatcher;
  /**
   * Minimum semantic score to rescue a same-file finding whose line does NOT
   * overlap the issue span (A2). Default 0.7. Ignored when the semantic matcher
   * returns undefined for the pair.
   */
  readonly semanticThreshold?: number;
}

/** Normalize a path for comparison: trim and drop a leading `./`. */
function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

/**
 * Decides whether a produced finding corresponds to a ground-truth issue using
 * deterministic, LLM-free rules: exact file match, line-range overlap, and
 * optional category/severity comparison where both sides provide the attribute.
 */
export class IssueMatcher {
  private readonly requireLineOverlap: boolean;
  private readonly requireCategoryMatch: boolean;
  private readonly requireSeverityMatch: boolean;
  private readonly semanticMatcher: ISemanticMatcher;
  private readonly semanticThreshold: number;

  public constructor(options: IssueMatcherOptions = {}) {
    this.requireLineOverlap = options.requireLineOverlap ?? true;
    this.requireCategoryMatch = options.requireCategoryMatch ?? false;
    this.requireSeverityMatch = options.requireSeverityMatch ?? false;
    this.semanticMatcher = options.semanticMatcher ?? new NoopSemanticMatcher();
    this.semanticThreshold = options.semanticThreshold ?? 0.7;
  }

  public match(finding: ReviewFinding, issue: GroundTruthIssue): MatchResult {
    // NOTE: fileMatch and lineOverlap are computed unconditionally here (before
    // any gate). JudgeScorePrecomputer.isCandidatePair reuses this via a bare
    // IssueMatcher and depends on that — keep them unconditional.
    const fileMatch = normalizePath(finding.file) === normalizePath(issue.file);
    const lineOverlap =
      finding.line >= issue.lineStart && finding.line <= issue.lineEnd;

    const categoryMatch =
      issue.category !== undefined
        ? finding.category.trim().toLowerCase() ===
          issue.category.trim().toLowerCase()
        : undefined;
    const severityMatch =
      issue.severity !== undefined ? finding.severity === issue.severity : undefined;

    const semanticScore = this.semanticMatcher.score(finding, issue);
    const semanticPass =
      semanticScore !== undefined && semanticScore >= this.semanticThreshold;

    let matched = fileMatch;
    if (this.requireLineOverlap) {
      matched = matched && (lineOverlap || semanticPass);
    }
    if (this.requireCategoryMatch && categoryMatch !== undefined) {
      matched = matched && categoryMatch;
    }
    if (this.requireSeverityMatch && severityMatch !== undefined) {
      matched = matched && severityMatch;
    }

    return {
      matched,
      fileMatch,
      lineOverlap,
      categoryMatch,
      severityMatch,
      semanticScore,
    };
  }
}
