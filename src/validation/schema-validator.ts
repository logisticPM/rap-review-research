import type { z } from "zod";
import {
  reviewResultInputSchema,
  reviewResultEnvelopeSchema,
  type ReviewResultInput,
} from "./schemas/review-result-schema.ts";
import {
  reviewFindingInputSchema,
  type ReviewFindingInput,
} from "./schemas/review-finding-schema.ts";
import { SchemaValidationError } from "./validation-errors.ts";

/** A validated review plus the count of malformed findings that were dropped. */
export interface SchemaValidationResult {
  readonly value: ReviewResultInput;
  readonly droppedFindings: number;
}

/**
 * Validates a parsed object against the review-result schema (Zod).
 *
 * The top-level envelope is strict (a string `summary` and a `findings` array).
 * Findings are validated **individually**: a single malformed finding is
 * dropped rather than discarding the whole review. Rejecting the entire review
 * on one bad finding unfairly penalises single-call architectures (agentless
 * has no redundancy, so it fails outright) while multi-call architectures
 * absorb the same defect across their other calls — biasing the comparison.
 * Dropped findings are counted so the caller can record a repair.
 *
 * It never invents data: dropped findings are discarded, not patched.
 */
export class SchemaValidator {
  public validate(parsed: unknown): SchemaValidationResult {
    // Fast path: a fully valid result drops nothing.
    const strict = reviewResultInputSchema.safeParse(parsed);
    if (strict.success) {
      return { value: strict.data, droppedFindings: 0 };
    }

    // The envelope must still be well-formed; only per-finding defects recover.
    const envelope = reviewResultEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new SchemaValidationError(formatIssues(envelope.error));
    }

    const findings: ReviewFindingInput[] = [];
    let droppedFindings = 0;
    for (const raw of envelope.data.findings) {
      const finding = reviewFindingInputSchema.safeParse(raw);
      if (finding.success) {
        findings.push(finding.data);
      } else {
        droppedFindings += 1;
      }
    }

    return {
      value: {
        summary: envelope.data.summary,
        riskLevel: envelope.data.riskLevel,
        findings,
      },
      droppedFindings,
    };
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
