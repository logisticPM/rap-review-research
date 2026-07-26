import type {
  RawReviewResult,
  ValidatedReviewResult,
} from "../models/review-result.ts";
import type { ValidationMetadata } from "../models/validation-metadata.ts";
import type {
  IOutputValidator,
  OutputValidationContext,
} from "../engines/experiment/ports.ts";
import type { Logger } from "../shared/logger.ts";

import { NoopLogger } from "../shared/logger.ts";
import { ResponseCleaner } from "./response-cleaner.ts";
import { JSONExtractor } from "./json-extractor.ts";
import { SchemaValidator } from "./schema-validator.ts";
import { ResultNormalizer } from "./result-normalizer.ts";
import { JSONExtractionError } from "./validation-errors.ts";
import { SCHEMA_VERSION } from "./schemas/review-result-schema.ts";

export interface ValidationEngineDependencies {
  readonly cleaner?: ResponseCleaner;
  readonly extractor?: JSONExtractor;
  readonly validator?: SchemaValidator;
  readonly normalizer?: ResultNormalizer;
  readonly logger?: Logger;
}

/**
 * Converts a {@link RawReviewResult} into a schema-valid
 * {@link ValidatedReviewResult}: clean → extract → parse → validate → normalize,
 * then attach validation metadata.
 *
 * Pure and deterministic: it calls no external service, accesses no repository,
 * and makes no LLM/provider/AWS calls. It repairs formatting (fences,
 * commentary, casing, out-of-range confidence) but never invents findings or
 * fields — missing required data fails validation.
 *
 * Implements {@link IOutputValidator} so it plugs into the Experiment Engine.
 */
export class ValidationEngine implements IOutputValidator {
  private readonly cleaner: ResponseCleaner;
  private readonly extractor: JSONExtractor;
  private readonly validator: SchemaValidator;
  private readonly normalizer: ResultNormalizer;
  private readonly logger: Logger;

  public constructor(deps: ValidationEngineDependencies = {}) {
    this.cleaner = deps.cleaner ?? new ResponseCleaner();
    this.extractor = deps.extractor ?? new JSONExtractor();
    this.validator = deps.validator ?? new SchemaValidator();
    this.normalizer = deps.normalizer ?? new ResultNormalizer();
    this.logger = deps.logger ?? new NoopLogger();
  }

  public async validate(
    raw: RawReviewResult,
    context: OutputValidationContext = {},
  ): Promise<ValidatedReviewResult> {
    const actions: string[] = [];

    const parsed = this.parse(raw, actions);
    const { value: validated, droppedFindings } = this.validator.validate(parsed);
    if (droppedFindings > 0) {
      actions.push(`dropped ${droppedFindings} malformed finding(s)`);
    }
    const normalized = this.normalizer.normalize(validated);
    actions.push(...normalized.actions);

    const repairActions = [...new Set(actions)];
    const validation: ValidationMetadata = {
      schemaVersion: context.schemaVersion ?? SCHEMA_VERSION,
      promptVersion: context.promptVersion ?? "unknown",
      validationPassed: true,
      repaired: repairActions.length > 0,
      repairActions,
    };

    this.logger.info("Validation completed", {
      experimentId: context.experimentId,
      architecture: raw.architecture,
      schemaVersion: validation.schemaVersion,
      promptVersion: validation.promptVersion,
      validationPassed: true,
      repaired: validation.repaired,
      repairActions,
    });

    return {
      architecture: raw.architecture,
      summary: normalized.summary,
      findings: normalized.findings,
      validation,
      latencyMs: raw.latencyMs,
      criticalPathLatencyMs: raw.criticalPathLatencyMs,
      truncatedCallCount: raw.truncatedCallCount,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      estimatedCostUsd: raw.estimatedCostUsd,
      llmCalls: raw.llmCalls,
      messageCount: raw.messageCount,
    };
  }

  /** Reduce raw output to a parsed JSON value (string → clean/extract/parse). */
  private parse(raw: RawReviewResult, actions: string[]): unknown {
    const output = raw.rawOutput;

    if (typeof output === "string") {
      const cleaned = this.cleaner.clean(output);
      actions.push(...cleaned.actions);
      const extracted = this.extractor.extract(cleaned.text);
      actions.push(...extracted.actions);
      try {
        return JSON.parse(extracted.json);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new JSONExtractionError(
          `Failed to parse extracted JSON: ${message}`,
        );
      }
    }

    if (output !== null && typeof output === "object") {
      // Already a structured object (e.g. some architectures/tests) — no repair.
      return output;
    }

    throw new JSONExtractionError(
      "Raw output is neither JSON text nor a JSON object.",
    );
  }
}
