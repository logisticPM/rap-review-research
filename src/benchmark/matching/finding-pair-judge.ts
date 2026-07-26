import type { ReviewFinding } from "../../models/finding.ts";
import type { LLMReviewRequest } from "../../llm/models/llm-review-request.ts";
import type { JudgeConfig } from "./judge-prompt.ts";

/**
 * Cross-model finding↔finding semantic matching (doc 09, Phase A).
 *
 * The heterogeneous-team experiment (doc 08) clustered findings across model
 * families with the lexical A4 key — but different families word the same
 * issue differently, so lexical matching under-merges and cross-model
 * corroboration is under-counted. This module is the semantic replacement:
 * an LLM judge answers "same underlying issue?" for a pair of findings, scores
 * are cached (replayable at zero further cost), and clustering is a
 * deterministic union-find over cached scores.
 *
 * The judge should be a model family that is NOT a team member (the team is
 * Claude+DeepSeek+Llama, and Llama is also the finding→golden judge), keeping
 * the non-circular triangle intact — hence the Nova default. Panickssery et
 * al. (arXiv:2404.13076) document the self-preference bias this avoids.
 */

/**
 * Default pair judge: Amazon Nova Pro — a fourth model family, distinct from
 * all three team members AND from the finding→golden judge (Llama 3.3).
 * Override via `PAIR_JUDGE_MODEL` if Nova is not enabled in the region, and
 * record the overlap as a threat to validity if the fallback shares a family
 * with a team member.
 */
export const DEFAULT_PAIR_JUDGE_CONFIG: JudgeConfig = {
  modelId: "us.amazon.nova-pro-v1:0",
  temperature: 0,
  maxTokens: 64,
};

const PAIR_JUDGE_SYSTEM_PROMPT =
  "You are a strict evaluator for a code-review benchmark. You are given TWO " +
  "findings, each produced independently by a different automated reviewer on " +
  "the SAME pull-request diff. Decide whether they describe THE SAME underlying " +
  "problem at the same code location. Different reviewers word the same issue " +
  "very differently: allow reworded titles, different levels of detail, and " +
  "small line differences. Two findings in the same file that flag DIFFERENT " +
  "problems (or the same kind of problem on clearly different code) are NOT the " +
  'same. Respond with ONLY a JSON object {"score": n} where n is in [0,1]: ' +
  "1 = certainly the same issue, 0 = certainly different. Output no other text.";

function renderFinding(f: ReviewFinding): string {
  return `file: ${f.file}\nline: ${f.line}\ntitle: ${f.title}\ndescription: ${f.description}`;
}

/** Judge prompt for one (finding, finding) pair. Reuses `parseJudgeScore`. */
export function buildFindingPairPrompt(
  a: ReviewFinding,
  b: ReviewFinding,
  config: JudgeConfig,
): LLMReviewRequest {
  return {
    systemPrompt: PAIR_JUDGE_SYSTEM_PROMPT,
    userPrompt: `## Finding A\n${renderFinding(a)}\n\n## Finding B\n${renderFinding(b)}`,
    modelId: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

/**
 * Stable, ORDER-INSENSITIVE key for one (finding, finding) pair. As with the
 * finding→golden `pairKey`, `line` is excluded so A3 re-anchoring cannot cause
 * cache misses; file+title+description identify the semantic content.
 */
export function findingPairKey(a: ReviewFinding, b: ReviewFinding): string {
  const side = (f: ReviewFinding): string => JSON.stringify([f.file, f.title, f.description]);
  const [x, y] = [side(a), side(b)].sort();
  return `${x}||${y}`;
}

/**
 * Serializable store of pair-judge scores keyed by unordered pair identity.
 * Same design as `SemanticScoreCache`; persisted, so re-clustering (e.g. at a
 * different threshold) costs zero further judge calls.
 */
export class FindingPairScoreCache {
  private readonly scores = new Map<string, number>();

  public get(a: ReviewFinding, b: ReviewFinding): number | undefined {
    return this.scores.get(findingPairKey(a, b));
  }
  public set(a: ReviewFinding, b: ReviewFinding, score: number): void {
    this.scores.set(findingPairKey(a, b), score);
  }
  public has(a: ReviewFinding, b: ReviewFinding): boolean {
    return this.scores.has(findingPairKey(a, b));
  }
  public get size(): number {
    return this.scores.size;
  }
  public toJSON(): Record<string, number> {
    return Object.fromEntries(this.scores);
  }
  public static fromJSON(data: Record<string, number>): FindingPairScoreCache {
    const cache = new FindingPairScoreCache();
    for (const [key, value] of Object.entries(data)) {
      cache.scores.set(key, value);
    }
    return cache;
  }
}

/** One team member's finding, tagged with which member produced it. */
export interface MemberFinding {
  readonly finding: ReviewFinding;
  /** Index of the team member (run or model family) that produced it. */
  readonly member: number;
}

/** A cluster of findings judged to be the same underlying issue. */
export interface SemanticCluster {
  /** Deterministic representative: the first finding in input order. */
  readonly rep: ReviewFinding;
  /** Distinct member indices that corroborate this issue. */
  readonly members: ReadonlySet<number>;
  readonly findings: readonly ReviewFinding[];
}

const normalizePath = (p: string): string => p.trim().replace(/^\.\//, "");

/**
 * Candidate pairs worth judging: same (normalized) file, DIFFERENT member.
 * Within-member duplicates are the within-run dedup's job, and cross-file
 * findings can never be the same located issue — blocking on both keeps the
 * judge bill proportional to genuine ambiguity.
 */
export function listCandidatePairs(
  members: readonly MemberFinding[],
): [ReviewFinding, ReviewFinding][] {
  const pairs: [ReviewFinding, ReviewFinding][] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i]!;
      const b = members[j]!;
      if (a.member === b.member) continue;
      if (normalizePath(a.finding.file) !== normalizePath(b.finding.file)) continue;
      pairs.push([a.finding, b.finding]);
    }
  }
  return pairs;
}

/** Result of clustering: clusters plus any pairs the cache has no score for. */
export interface ClusterOutcome {
  readonly clusters: readonly SemanticCluster[];
  /** Candidate pairs that were NOT judged yet (dry runs report these). */
  readonly pendingPairs: readonly [ReviewFinding, ReviewFinding][];
}

/**
 * Deterministic union-find clustering over cached pair scores: two findings
 * are linked when the judge scored their pair ≥ `threshold`. Unjudged
 * candidate pairs never link (and are surfaced in `pendingPairs` so callers
 * can budget/resume). Transitive merges are intentional — if A≈B and B≈C the
 * three are one issue even if the A–C pair itself scored low or is unjudged.
 */
export function clusterFindingsSemantically(
  members: readonly MemberFinding[],
  cache: FindingPairScoreCache,
  threshold: number,
): ClusterOutcome {
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const [ri, rj] = [find(i), find(j)];
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  };

  const pendingPairs: [ReviewFinding, ReviewFinding][] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i]!;
      const b = members[j]!;
      if (a.member === b.member) continue;
      if (normalizePath(a.finding.file) !== normalizePath(b.finding.file)) continue;
      const score = cache.get(a.finding, b.finding);
      if (score === undefined) pendingPairs.push([a.finding, b.finding]);
      else if (score >= threshold) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  members.forEach((_, i) => {
    const root = find(i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), i]);
  });
  const clusters: SemanticCluster[] = [...byRoot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, indices]) => ({
      rep: members[indices[0]!]!.finding,
      members: new Set(indices.map((i) => members[i]!.member)),
      findings: indices.map((i) => members[i]!.finding),
    }));
  return { clusters, pendingPairs };
}
