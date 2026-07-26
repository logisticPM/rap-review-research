/**
 * The minimal locus two findings are compared on. Both `ReviewFinding` and the
 * consensus `CandidateFinding` satisfy this structurally.
 */
export interface FindingLocus {
  readonly file: string;
  readonly line: number;
  readonly title: string;
}

/**
 * Options controlling when two findings are treated as duplicates.
 *
 * The defaults reproduce the *intent* of the old exact `file|line|title` key
 * (identical findings still merge) while also merging paraphrases: the same
 * issue reported a line or two apart with reworded titles. Kept deterministic
 * and LLM-free — a semantic matcher (RFC-13 A2) can be layered on later behind
 * the same call site.
 */
export interface FindingDedupOptions {
  /**
   * Maximum absolute line distance for two findings to share a locus.
   * Default 2 (the old key required an exact line match, i.e. distance 0).
   */
  readonly lineProximity?: number;
  /**
   * Minimum Jaccard overlap of title tokens (after stop-word removal) for two
   * findings to describe the same issue, in [0, 1]. Default 0.5.
   */
  readonly titleSimilarity?: number;
}

const DEFAULT_LINE_PROXIMITY = 2;
const DEFAULT_TITLE_SIMILARITY = 0.5;

/** Short, high-frequency words that carry little discriminative signal. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "in",
  "on",
  "of",
  "to",
  "is",
  "for",
  "and",
  "or",
  "with",
  "at",
  "by",
]);

/** Normalize a path for comparison: trim and drop a leading `./`. */
function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

/** Lowercase alphanumeric tokens of a title, minus stop words. */
function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity of two token sets in [0, 1]; two empty sets score 1. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
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

/**
 * Deterministic duplicate predicate: two findings are duplicates when they are
 * in the same file, within `lineProximity` lines of each other, and their
 * titles overlap by at least `titleSimilarity`. Symmetric and LLM-free.
 */
export function areDuplicateFindings(
  a: FindingLocus,
  b: FindingLocus,
  options: FindingDedupOptions = {},
): boolean {
  const lineProximity = options.lineProximity ?? DEFAULT_LINE_PROXIMITY;
  const titleSimilarity = options.titleSimilarity ?? DEFAULT_TITLE_SIMILARITY;

  if (normalizePath(a.file) !== normalizePath(b.file)) {
    return false;
  }
  if (Math.abs(a.line - b.line) > lineProximity) {
    return false;
  }
  return jaccard(titleTokens(a.title), titleTokens(b.title)) >= titleSimilarity;
}

/**
 * Collapse a list to its unique findings under {@link areDuplicateFindings}: a
 * finding is kept unless it duplicates one already kept. Order-stable. Used by
 * the SWE coverage path (and available anywhere unique findings are needed).
 */
export function dedupeFindings<T extends FindingLocus>(
  findings: readonly T[],
  options: FindingDedupOptions = {},
): T[] {
  const unique: T[] = [];
  for (const finding of findings) {
    if (!unique.some((kept) => areDuplicateFindings(kept, finding, options))) {
      unique.push(finding);
    }
  }
  return unique;
}
