import { z } from "zod";
import { reviewFindingInputSchema } from "./review-finding-schema.ts";

/** Version of the review-result schema, recorded in ValidationMetadata. */
export const SCHEMA_VERSION = "review-result-v1";

/**
 * Zod schema for a review result as it appears in *raw* model output.
 * `riskLevel` is accepted but not required (it is not part of the canonical
 * ValidatedReviewResult); `findings` is required (use `[]` for none).
 */
export const reviewResultInputSchema = z.object({
  summary: z.string(),
  riskLevel: z.string().optional(),
  findings: z.array(reviewFindingInputSchema),
});

export type ReviewResultInput = z.infer<typeof reviewResultInputSchema>;

/**
 * Envelope schema for lenient validation: the top level must be well-formed (a
 * string `summary` and a `findings` *array*), but each finding is validated
 * individually so one malformed finding does not discard the whole review. See
 * {@link SchemaValidator}.
 */
export const reviewResultEnvelopeSchema = z.object({
  summary: z.string(),
  riskLevel: z.string().optional(),
  findings: z.array(z.unknown()),
});
