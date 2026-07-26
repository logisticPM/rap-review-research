import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { BenchmarkRun } from "../models/benchmark-run.ts";
import type { JudgeConfig } from "./judge-prompt.ts";
import type { SemanticScoreCache } from "./semantic-score-cache.ts";

import { buildJudgePrompt, parseJudgeScore } from "./judge-prompt.ts";
import { IssueMatcher } from "./issue-matcher.ts";

/**
 * Async pre-pass (A2): fills a {@link SemanticScoreCache} with judge scores for
 * candidate pairs, so the synchronous evaluator can read them later. Judges each
 * uncached candidate pair exactly once. Deterministic given the provider.
 */
export class JudgeScorePrecomputer {
  private readonly provider: ILLMProvider;
  private readonly config: JudgeConfig;
  private readonly locationMatcher = new IssueMatcher();

  public constructor(provider: ILLMProvider, config: JudgeConfig) {
    this.provider = provider;
    this.config = config;
  }

  /**
   * A pair is worth judging only when the finding is in the issue's file but its
   * line does NOT overlap the issue span — the only case a semantic score can
   * flip `matched`. Delegates to IssueMatcher so this stays in lockstep with the
   * evaluator's own file/line rule (no duplicated predicate).
   */
  private isCandidatePair(finding: ReviewFinding, issue: GroundTruthIssue): boolean {
    const result = this.locationMatcher.match(finding, issue);
    return result.fileMatch && !result.lineOverlap;
  }

  /**
   * If a judge call throws, the error propagates (fail-fast). Scores are cached
   * incrementally and already-cached candidate pairs are skipped, so a caller
   * can simply retry `precompute` to resume — successfully judged pairs are not
   * re-judged.
   */
  public async precompute(
    runs: BenchmarkRun[],
    cache: SemanticScoreCache,
  ): Promise<void> {
    for (const run of runs) {
      for (const finding of run.producedFindings) {
        for (const issue of run.groundTruth) {
          if (!this.isCandidatePair(finding, issue) || cache.has(finding, issue)) {
            continue;
          }
          const response = await this.provider.review(
            buildJudgePrompt(finding, issue, this.config),
          );
          const score = parseJudgeScore(response.text);
          if (score !== undefined) {
            cache.set(finding, issue, score);
          }
        }
      }
    }
  }
}
