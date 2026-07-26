import type { ReviewFinding } from "../models/finding.ts";
import type { GoldenComment } from "./models/golden-comment.ts";
import type { CoverageScoreCache } from "./matching/coverage-score-cache.ts";
import { dedupeFindings } from "../architectures/shared/finding-dedup.ts";

/** Coverage of one arm's findings against a PR's golden comments (SWE-PRBench). */
export interface SemanticCoverageResult {
  readonly commentCount: number;
  readonly uniqueFindingCount: number;
  readonly matchedComments: number;
  readonly matchedFindings: number;
  readonly coverage: number; // recall: fraction of golden comments covered
  readonly precision: number; // fraction of unique findings matching a comment
  readonly f1: number;
  readonly coverageBySeverity: Record<string, number>;
}

/**
 * Scores produced findings against location-less golden comments via a
 * precomputed judge cache (SWE-PRBench, Martian-faithful): a (finding, comment)
 * pair matches when its cached judge score ≥ threshold. Deterministic given the
 * cache. Mirrors Martian's precision/recall; unmatched findings are noise
 * (report the count separately as possibly-beyond-human — the caller does this).
 */
export class SemanticCoverageEvaluator {
  private readonly threshold: number;

  public constructor(threshold = 0.7) {
    this.threshold = threshold;
  }

  public evaluate(
    producedFindings: ReviewFinding[],
    goldenComments: GoldenComment[],
    cache: CoverageScoreCache,
  ): SemanticCoverageResult {
    const unique = dedupeFindings(producedFindings);
    const matches = (finding: ReviewFinding, comment: GoldenComment): boolean => {
      const score = cache.get(finding, comment);
      return score !== undefined && score >= this.threshold;
    };

    const matchedComments = goldenComments.filter((c) =>
      unique.some((f) => matches(f, c)),
    ).length;
    const matchedFindings = unique.filter((f) =>
      goldenComments.some((c) => matches(f, c)),
    ).length;

    const coverage = ratio(matchedComments, goldenComments.length);
    const precision = ratio(matchedFindings, unique.length);
    const f1 = coverage + precision === 0 ? 0 : (2 * coverage * precision) / (coverage + precision);

    const coverageBySeverity: Record<string, number> = {};
    for (const severity of new Set(goldenComments.map((c) => c.severity ?? "unspecified"))) {
      const inBucket = goldenComments.filter((c) => (c.severity ?? "unspecified") === severity);
      const covered = inBucket.filter((c) => unique.some((f) => matches(f, c))).length;
      coverageBySeverity[severity] = ratio(covered, inBucket.length);
    }

    return {
      commentCount: goldenComments.length,
      uniqueFindingCount: unique.length,
      matchedComments,
      matchedFindings,
      coverage,
      precision,
      f1,
      coverageBySeverity,
    };
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
