import type { ReviewFinding } from "../models/finding.ts";
import type { GroundTruthIssue } from "./models/ground-truth-issue.ts";
import type { BenchmarkRun } from "./models/benchmark-run.ts";
import type { BenchmarkResult } from "./models/benchmark-result.ts";

import { IssueMatcher } from "./matching/issue-matcher.ts";
import { maxBipartiteMatching } from "./matching/bipartite-matcher.ts";
import { resolveSnippetLine } from "./matching/snippet-locator.ts";
import { areDuplicateFindings } from "../architectures/shared/finding-dedup.ts";

export interface GroundTruthEvaluatorDependencies {
  /** The matcher deciding produced-finding ↔ ground-truth correspondence. */
  readonly matcher?: IssueMatcher;
}

/**
 * Scores one {@link BenchmarkRun} against its ground truth into a
 * {@link BenchmarkResult}: precision, recall, F1, localization accuracy, and the
 * true/false positive/negative counts.
 *
 * Deterministic and pure — no I/O, no LLM. Matching is a maximum one-to-one
 * assignment (each finding matches at most one issue and vice-versa) so a single
 * finding cannot inflate the true-positive count, and the counts do not depend
 * on the order in which findings are produced.
 */
export class GroundTruthEvaluator {
  private readonly matcher: IssueMatcher;

  public constructor(deps: GroundTruthEvaluatorDependencies = {}) {
    this.matcher = deps.matcher ?? new IssueMatcher();
  }

  public evaluate(run: BenchmarkRun): BenchmarkResult {
    const produced = run.producedFindings;
    const groundTruth = run.groundTruth;
    const producedCount = produced.length;
    const groundTruthCount = groundTruth.length;

    // True positives: strict match (file + line overlap, per matcher config).
    const truePositives = this.maxMatchCount(
      produced,
      groundTruth,
      (f, g) => this.matcher.match(f, g).matched,
    );
    // Detected: file-level match only — the denominator for localization.
    // `fileMatch` is a superset of `matched`, so detected >= truePositives and
    // localizationAccuracy stays in [0, 1].
    const detected = this.maxMatchCount(
      produced,
      groundTruth,
      (f, g) => this.matcher.match(f, g).fileMatch,
    );

    const falsePositives = producedCount - truePositives;
    const falseNegatives = groundTruthCount - truePositives;

    const precision = producedCount > 0 ? truePositives / producedCount : 0;
    const recall = groundTruthCount > 0 ? truePositives / groundTruthCount : 0;
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
    const localizationAccuracy = detected > 0 ? truePositives / detected : 0;

    // Snippet-anchored localization (A3): when the diff is available, re-anchor
    // each finding that quotes a snippet to its true line, then re-score strict
    // matches over the same file-level denominator. Measures understanding
    // rather than the model's diff-line arithmetic. Falls back to the raw
    // localization when no diff is supplied or no snippet resolves.
    const snippetLocalizationAccuracy = run.rawDiff
      ? this.snippetLocalization(produced, groundTruth, detected, run.rawDiff)
      : localizationAccuracy;

    // Unique-issue precision: collapse near-duplicate produced findings so a
    // cluster of paraphrases counts once, then re-match. Puts an architecture
    // with a dedup stage and one without on equal footing. Matching on the
    // clustered representatives keeps uniquePrecision in [0, 1].
    const uniqueRepresentatives = this.clusterRepresentatives(produced);
    const uniqueProducedCount = uniqueRepresentatives.length;
    const uniqueTruePositives = maxBipartiteMatching(
      uniqueProducedCount,
      groundTruthCount,
      (f, g) =>
        this.matcher.match(
          uniqueRepresentatives[f] as ReviewFinding,
          groundTruth[g] as GroundTruthIssue,
        ).matched,
    );
    const uniquePrecision =
      uniqueProducedCount > 0 ? uniqueTruePositives / uniqueProducedCount : 0;

    return {
      runId: run.runId,
      datasetId: run.datasetId,
      instanceId: run.instanceId,
      snapshotId: run.snapshotId,
      experimentId: run.experimentId,
      architecture: run.architecture,
      groundTruthCount,
      producedCount,
      uniqueProducedCount,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      uniquePrecision,
      recall,
      f1,
      localizationAccuracy,
      snippetLocalizationAccuracy,
    };
  }

  /**
   * Localization after re-anchoring snippet-bearing findings to the line the
   * snippet occupies in the diff (reported line kept when it does not resolve).
   * Numerator is strict matches on the anchored lines; denominator is the same
   * file-level `detected` count (unaffected by line changes), so the result
   * stays in [0, 1].
   */
  private snippetLocalization(
    produced: ReviewFinding[],
    groundTruth: GroundTruthIssue[],
    detected: number,
    rawDiff: string,
  ): number {
    if (detected === 0) {
      return 0;
    }
    const anchored = produced.map((finding) => {
      if (finding.snippet === undefined) {
        return finding;
      }
      const line = resolveSnippetLine(rawDiff, finding.file, finding.snippet);
      return line === undefined ? finding : { ...finding, line };
    });
    const anchoredTruePositives = maxBipartiteMatching(
      anchored.length,
      groundTruth.length,
      (f, g) =>
        this.matcher.match(
          anchored[f] as ReviewFinding,
          groundTruth[g] as GroundTruthIssue,
        ).matched,
    );
    return anchoredTruePositives / detected;
  }

  /**
   * Collapse near-duplicate produced findings into cluster representatives using
   * the same predicate as the synthesizers (A4). Each finding joins the first
   * existing cluster it duplicates, otherwise starts a new one; the first member
   * (discovery order) represents the cluster. Deterministic.
   */
  private clusterRepresentatives(findings: ReviewFinding[]): ReviewFinding[] {
    const representatives: ReviewFinding[] = [];
    for (const finding of findings) {
      const isDuplicate = representatives.some((rep) =>
        areDuplicateFindings(rep, finding),
      );
      if (!isDuplicate) {
        representatives.push(finding);
      }
    }
    return representatives;
  }

  /**
   * Maximum one-to-one match count between findings and ground-truth issues
   * under `predicate`. Uses maximum bipartite matching so the count is the true
   * optimum (a greedy first-fit can under-count when one finding could satisfy
   * several issues) and is invariant to the ordering of the findings.
   */
  private maxMatchCount(
    findings: ReviewFinding[],
    groundTruth: GroundTruthIssue[],
    predicate: (finding: ReviewFinding, issue: GroundTruthIssue) => boolean,
  ): number {
    return maxBipartiteMatching(
      findings.length,
      groundTruth.length,
      (f, g) =>
        predicate(
          findings[f] as ReviewFinding,
          groundTruth[g] as GroundTruthIssue,
        ),
    );
  }
}
