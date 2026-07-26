import type { SeverityLevel } from "../../models/finding.ts";

/**
 * One human review comment from SWE-PRBench (Martian). Location-less: the
 * benchmark's golden comments are PR-level free text with a severity label and
 * NO file/line. Matched semantically (see SemanticCoverageEvaluator), never by
 * location.
 */
export interface GoldenComment {
  readonly id: string;
  readonly body: string;
  readonly severity?: SeverityLevel;
}
