import type { ReviewFinding, SeverityLevel } from "../../models/finding.ts";
import type { SpecialistReviewResult } from "./models/specialist-review-result.ts";
import type { HierarchicalReviewResult } from "./models/hierarchical-review-result.ts";

import { areDuplicateFindings } from "../shared/finding-dedup.ts";

const SEVERITY_ORDER: Record<SeverityLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Deterministically merges specialist findings into a single review.
 *
 * It performs NO further LLM review — it operates only on specialist outputs:
 * deduplicates near-duplicates (same file, nearby line, similar title — see
 * {@link areDuplicateFindings}), resolves conflicts (highest severity wins,
 * then highest confidence), counts duplicates, and generates a summary. Pure
 * and deterministic; never mutates inputs.
 */
export class Synthesizer {
  public synthesize(
    specialistResults: SpecialistReviewResult[],
  ): HierarchicalReviewResult {
    const mergedFindings: ReviewFinding[] = [];
    let total = 0;

    for (const specialist of specialistResults) {
      for (const finding of specialist.findings) {
        total += 1;
        const index = mergedFindings.findIndex((existing) =>
          areDuplicateFindings(existing, finding),
        );
        if (index === -1) {
          mergedFindings.push(finding);
        } else {
          mergedFindings[index] = resolveConflict(
            mergedFindings[index] as ReviewFinding,
            finding,
          );
        }
      }
    }

    const duplicateCount = total - mergedFindings.length;

    return {
      managerSummary: buildSummary(specialistResults, mergedFindings.length, duplicateCount),
      specialistResults,
      mergedFindings,
      duplicateCount,
    };
  }
}

/** Highest severity wins; ties broken by highest confidence; then keep existing. */
function resolveConflict(a: ReviewFinding, b: ReviewFinding): ReviewFinding {
  if (SEVERITY_ORDER[b.severity] > SEVERITY_ORDER[a.severity]) {
    return b;
  }
  if (SEVERITY_ORDER[b.severity] < SEVERITY_ORDER[a.severity]) {
    return a;
  }
  return b.confidence > a.confidence ? b : a;
}

function buildSummary(
  specialistResults: SpecialistReviewResult[],
  mergedCount: number,
  duplicateCount: number,
): string {
  const roles = specialistResults.map((s) => s.role).join(", ");
  return (
    `Hierarchical review by ${specialistResults.length} specialist(s) ` +
    `(${roles}): ${mergedCount} finding(s) after removing ` +
    `${duplicateCount} duplicate(s).`
  );
}
