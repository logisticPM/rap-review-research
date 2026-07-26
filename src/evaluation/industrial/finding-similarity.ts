import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../../benchmark/models/ground-truth-issue.ts";

import { IssueMatcher } from "../../benchmark/matching/issue-matcher.ts";

/**
 * Decides whether two independently produced findings describe the *same* issue.
 *
 * This is the primitive behind cross-architecture agreement, human-review
 * overlap, and later-fix rate. It reuses the benchmark {@link IssueMatcher} for
 * the file + line dimension (a reference finding is projected onto a
 * {@link GroundTruthIssue} spanning `line ± lineWindow`) and adds a
 * category-or-title agreement check on top. Deterministic and LLM-free — title
 * similarity is a token Jaccard, matching the repo's no-LLM matching policy.
 *
 * Two findings agree when they share a file, sit within `lineWindow` lines of
 * each other, and *either* carry the same category *or* have similar titles.
 */
export interface FindingSimilarityOptions {
  /** Max line distance to still count as the same location. Default 2. */
  readonly lineWindow?: number;
  /** Title token-Jaccard at/above which titles are "similar". Default 0.5. */
  readonly titleThreshold?: number;
}

export class FindingSimilarity {
  private readonly lineWindow: number;
  private readonly titleThreshold: number;
  private readonly matcher: IssueMatcher;

  public constructor(options: FindingSimilarityOptions = {}) {
    this.lineWindow = Math.max(0, options.lineWindow ?? 2);
    this.titleThreshold = options.titleThreshold ?? 0.5;
    this.matcher = new IssueMatcher({ requireLineOverlap: true });
  }

  /** True when `a` and `b` plausibly describe the same underlying issue. */
  public agree(a: ReviewFinding, b: ReviewFinding): boolean {
    const location = this.matcher.match(a, this.asIssue(b));
    if (!location.matched) {
      return false;
    }
    // Same spot: accept if the category matches, otherwise fall back to title.
    if (location.categoryMatch === true) {
      return true;
    }
    return this.titlesSimilar(a.title, b.title);
  }

  /** Project a finding into a single-point {@link GroundTruthIssue} with a window. */
  private asIssue(f: ReviewFinding): GroundTruthIssue {
    return {
      id: f.id,
      file: f.file,
      lineStart: f.line - this.lineWindow,
      lineEnd: f.line + this.lineWindow,
      category: f.category,
    };
  }

  private titlesSimilar(a: string, b: string): boolean {
    return jaccard(tokenize(a), tokenize(b)) >= this.titleThreshold;
  }
}

/** Lowercase word tokens, punctuation stripped, deduplicated. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
