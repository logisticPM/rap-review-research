import type { ReviewFinding } from "../../models/finding.ts";
import type { GoldenComment } from "../models/golden-comment.ts";

/**
 * Stable key for one (finding, golden-comment) pair. LLM-free. `finding.line` is
 * intentionally excluded (mirrors SemanticScoreCache: A3 re-anchors the line);
 * `comment.id` + `comment.body` identify the human comment (it has no location).
 */
export function coveragePairKey(finding: ReviewFinding, comment: GoldenComment): string {
  return JSON.stringify([finding.file, finding.title, finding.description, comment.id, comment.body]);
}

/** Serializable store of coverage-judge scores, keyed by pair identity. */
export class CoverageScoreCache {
  private readonly scores = new Map<string, number>();

  public get(finding: ReviewFinding, comment: GoldenComment): number | undefined {
    return this.scores.get(coveragePairKey(finding, comment));
  }
  public set(finding: ReviewFinding, comment: GoldenComment, score: number): void {
    this.scores.set(coveragePairKey(finding, comment), score);
  }
  public has(finding: ReviewFinding, comment: GoldenComment): boolean {
    return this.scores.has(coveragePairKey(finding, comment));
  }
  public toJSON(): Record<string, number> {
    return Object.fromEntries(this.scores);
  }
  public static fromJSON(data: Record<string, number>): CoverageScoreCache {
    const cache = new CoverageScoreCache();
    for (const [key, value] of Object.entries(data)) {
      cache.scores.set(key, value);
    }
    return cache;
  }
}
