import type { ReviewFinding } from "../../models/finding.ts";
import type { StaticAnalysisFinding } from "./models.ts";

/**
 * Static-analysis agreement for one architecture on one PR.
 *
 * The proportion of AI findings that coincide with an issue independently
 * reported by a conventional static analysis tool (linter, type checker, SAST)
 * on the same pull request. A finding corroborated by an established analyzer is
 * more credible; because analyzers have their own false positives and coverage
 * gaps, this is reported as a corroboration rate, never as recall.
 *
 * Matching is by file and line proximity, plus category correspondence when the
 * static tool provides one (doc §6: "file, line, and rule or category"). Returns
 * a value in [0, 1]; 0 when there are no findings.
 */
export class StaticAnalysisAgreementCalculator {
  private readonly lineWindow: number;

  public constructor(lineWindow = 3) {
    this.lineWindow = Math.max(0, lineWindow);
  }

  public calculate(
    findings: ReviewFinding[],
    staticFindings: StaticAnalysisFinding[],
  ): number {
    if (findings.length === 0) {
      return 0;
    }
    const matched = findings.filter((finding) =>
      staticFindings.some((sa) => this.corroborates(finding, sa)),
    ).length;
    return matched / findings.length;
  }

  /** A static finding corroborates when they share a file, sit within the line
   *  window, and (if the tool reported a category) share that category. */
  private corroborates(
    finding: ReviewFinding,
    sa: StaticAnalysisFinding,
  ): boolean {
    if (normalizePath(finding.file) !== normalizePath(sa.file)) {
      return false;
    }
    if (Math.abs(finding.line - sa.line) > this.lineWindow) {
      return false;
    }
    if (sa.category !== undefined) {
      return finding.category.trim().toLowerCase() === sa.category.trim().toLowerCase();
    }
    return true; // no category from the tool: file + line proximity is enough
  }
}

/** Normalize a path for comparison: trim and drop a leading `./`. */
function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}
