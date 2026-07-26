import { z } from "zod";

/**
 * Zod schema for a single finding as it appears in *raw* model output, before
 * normalization. `severity`/`category` are accepted as free strings here and
 * normalized later (casing); `id` is optional and assigned by the normalizer.
 *
 * Required fields are enforced — the engine never invents missing data.
 */
export const reviewFindingInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  severity: z.string().min(1),
  category: z.string().min(1),
  file: z.string().min(1),
  line: z.number(),
  snippet: z.string().optional(),
  description: z.string().min(1),
  recommendation: z.string().min(1),
  confidence: z.number(),
});

export type ReviewFindingInput = z.infer<typeof reviewFindingInputSchema>;
