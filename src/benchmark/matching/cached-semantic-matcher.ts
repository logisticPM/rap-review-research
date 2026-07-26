import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { ISemanticMatcher } from "./semantic-matcher.ts";
import type { SemanticScoreCache } from "./semantic-score-cache.ts";

/**
 * A synchronous {@link ISemanticMatcher} that reads precomputed judge scores
 * from a {@link SemanticScoreCache} (A2). Makes no LLM call — the async judging
 * happens once in {@link JudgeScorePrecomputer}, keeping the evaluator sync.
 */
export class CachedSemanticMatcher implements ISemanticMatcher {
  private readonly cache: SemanticScoreCache;

  public constructor(cache: SemanticScoreCache) {
    this.cache = cache;
  }

  public score(finding: ReviewFinding, issue: GroundTruthIssue): number | undefined {
    return this.cache.get(finding, issue);
  }
}
