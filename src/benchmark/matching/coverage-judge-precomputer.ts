import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { BenchmarkRun } from "../models/benchmark-run.ts";
import type { GoldenComment } from "../models/golden-comment.ts";
import type { JudgeConfig } from "./judge-prompt.ts";
import type { CoverageScoreCache } from "./coverage-score-cache.ts";

import { buildCoverageJudgePrompt, parseJudgeScore } from "./judge-prompt.ts";
import { dedupeFindings } from "../../architectures/shared/finding-dedup.ts";

/**
 * Async pre-pass (SWE coverage): fills a {@link CoverageScoreCache} with judge
 * scores for every (unique finding × golden comment) pair, so the synchronous
 * evaluator can read them later. No location filter — golden comments have no
 * location. Sequential and resumable (skips cached pairs); the caller wraps this
 * in retry-with-backoff on rate limits (see scripts/benchmark-swe-eval.ts).
 */
export class CoverageJudgePrecomputer {
  private readonly provider: ILLMProvider;
  private readonly config: JudgeConfig;

  public constructor(provider: ILLMProvider, config: JudgeConfig) {
    this.provider = provider;
    this.config = config;
  }

  public async precompute(
    runs: BenchmarkRun[],
    commentsByInstance: Map<string, GoldenComment[]>,
    cache: CoverageScoreCache,
  ): Promise<void> {
    for (const run of runs) {
      const comments = commentsByInstance.get(run.instanceId) ?? [];
      const uniqueFindings = dedupeFindings(run.producedFindings);
      for (const finding of uniqueFindings) {
        for (const comment of comments) {
          if (cache.has(finding, comment)) {
            continue;
          }
          const response = await this.provider.review(
            buildCoverageJudgePrompt(finding, comment, this.config),
          );
          const score = parseJudgeScore(response.text);
          if (score !== undefined) {
            cache.set(finding, comment, score);
          }
        }
      }
    }
  }
}
