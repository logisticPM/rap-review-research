import type { ReviewFinding } from "../../models/finding.ts";
import type { ChangedRange } from "./models.ts";

/**
 * Later-fix rate for one architecture on one PR.
 *
 * The proportion of AI findings whose location was subsequently modified by a
 * later commit (supplied as {@link ChangedRange}s mined from the repo history).
 * If a reviewer flagged a line and that line was later changed, that is weak but
 * genuinely *external* evidence the finding pointed at code that needed
 * attention — useful precisely because the RAP Portal has no ground truth.
 *
 * This is intentionally a coarse, optional signal: later changes have many
 * causes (refactors, unrelated features), so it corroborates rather than proves.
 * Returns a value in [0, 1]; 0 when there are no findings.
 */
export class LaterFixRateCalculator {
  public calculate(
    findings: ReviewFinding[],
    laterChanges: ChangedRange[],
  ): number {
    if (findings.length === 0) {
      return 0;
    }
    const touched = findings.filter((finding) =>
      laterChanges.some((change) => coversLocation(finding, change)),
    ).length;
    return touched / findings.length;
  }
}

/** True when a later change's range covers the finding's file and line. */
function coversLocation(finding: ReviewFinding, change: ChangedRange): boolean {
  return (
    normalizePath(finding.file) === normalizePath(change.file) &&
    finding.line >= change.lineStart &&
    finding.line <= change.lineEnd
  );
}

/** Normalize a path for comparison: trim and drop a leading `./`. */
function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}
