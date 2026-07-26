import type { ReviewFinding } from "../../models/finding.ts";
import type { FindingVerdict } from "./models.ts";

/**
 * LLM-judge validation rate for one architecture on one PR.
 *
 * The proportion of AI findings that an independent LLM judge — distinct from
 * the architectures that produced them — classified as `valid`, given the PR
 * diff. This is a *supporting corroboration* signal that scales in place of
 * scarce human review effort; because the judge can share biases with the
 * reviewer models, it is never treated as authoritative ground truth.
 *
 * This calculator is pure: the (impure) LLM calls happen outside the Evaluation
 * Engine and their {@link FindingVerdict}s are passed in, keyed by finding id.
 * `invalid`, `uncertain`, and unjudged findings all count as not-valid. Returns
 * a value in [0, 1]; 0 when there are no findings.
 */
export class LlmJudgeValidationCalculator {
  public calculate(
    findings: ReviewFinding[],
    verdicts: Readonly<Record<string, FindingVerdict>>,
  ): number {
    if (findings.length === 0) {
      return 0;
    }
    const valid = findings.filter((f) => verdicts[f.id] === "valid").length;
    return valid / findings.length;
  }
}
