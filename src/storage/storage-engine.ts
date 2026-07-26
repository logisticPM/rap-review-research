import type {
  RawReviewResult,
  ValidatedReviewResult,
} from "../models/review-result.ts";
import type { Clock } from "../shared/clock.ts";
import type { Logger } from "../shared/logger.ts";
import type { RawResultRepository } from "./raw-result-repository.ts";
import type { ValidatedResultRepository } from "./validated-result-repository.ts";
import type { FindingRepository } from "./finding-repository.ts";
import type {
  StoredRawReviewResult,
  StoredValidatedReviewResult,
  StoredReviewFinding,
  StoredExperimentResult,
} from "./stored-models.ts";

import { SystemClock } from "../shared/clock.ts";
import { NoopLogger } from "../shared/logger.ts";

export interface StoreRawResultInput {
  readonly experimentId: string;
  readonly rawResult: RawReviewResult;
}

export interface StoreValidatedResultInput {
  readonly experimentId: string;
  readonly validatedResult: ValidatedReviewResult;
}

/**
 * Coordinates persistence of experiment artifacts across the result/finding
 * repositories.
 */
export interface IStorageEngine {
  /** Persist the raw architecture result exactly as received. */
  storeRawResult(input: StoreRawResultInput): Promise<void>;
  /** Persist a validated result and its findings (separately). */
  storeValidatedResult(input: StoreValidatedResultInput): Promise<void>;
  /** Retrieve the composed stored artifacts for an experiment. */
  getExperimentResult(
    experimentId: string,
  ): Promise<StoredExperimentResult | null>;
}

export interface StorageEngineDependencies {
  readonly rawResults: RawResultRepository;
  readonly validatedResults: ValidatedResultRepository;
  readonly findings: FindingRepository;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/**
 * The Storage Engine (RFC-06).
 *
 * Responsibilities: stamp artifacts with `storedAt` and write them through the
 * repositories — raw exactly as received; validated only after validation
 * succeeds; findings separately.
 *
 * Non-responsibilities: importing PRs, running LLMs, validating JSON, computing
 * metrics, rendering UI, executing architectures. Infrastructure-agnostic: it
 * depends only on repository ports (in-memory today, DynamoDB/S3 later). It
 * never mutates caller-owned objects (repositories deep-clone on write/read).
 */
export class StorageEngine implements IStorageEngine {
  private readonly rawResults: RawResultRepository;
  private readonly validatedResults: ValidatedResultRepository;
  private readonly findings: FindingRepository;
  private readonly clock: Clock;
  private readonly logger: Logger;

  public constructor(deps: StorageEngineDependencies) {
    this.rawResults = deps.rawResults;
    this.validatedResults = deps.validatedResults;
    this.findings = deps.findings;
    this.clock = deps.clock ?? new SystemClock();
    this.logger = deps.logger ?? new NoopLogger();
  }

  public async storeRawResult(input: StoreRawResultInput): Promise<void> {
    const { experimentId, rawResult } = input;
    const stored: StoredRawReviewResult = {
      experimentId,
      architecture: rawResult.architecture,
      rawOutput: rawResult.rawOutput,
      summary: rawResult.summary,
      findings: rawResult.findings,
      inputTokens: rawResult.inputTokens,
      outputTokens: rawResult.outputTokens,
      latencyMs: rawResult.latencyMs,
      criticalPathLatencyMs: rawResult.criticalPathLatencyMs,
      truncatedCallCount: rawResult.truncatedCallCount,
      estimatedCostUsd: rawResult.estimatedCostUsd,
      llmCalls: rawResult.llmCalls,
      messageCount: rawResult.messageCount,
      storedAt: this.clock.nowIso(),
    };
    await this.rawResults.save(stored);
    this.logger.info("Stored raw result", {
      experimentId,
      architecture: rawResult.architecture,
    });
  }

  public async storeValidatedResult(
    input: StoreValidatedResultInput,
  ): Promise<void> {
    const { experimentId, validatedResult } = input;
    const storedAt = this.clock.nowIso();

    const stored: StoredValidatedReviewResult = {
      experimentId,
      architecture: validatedResult.architecture,
      summary: validatedResult.summary,
      findings: validatedResult.findings,
      validation: validatedResult.validation,
      latencyMs: validatedResult.latencyMs,
      criticalPathLatencyMs: validatedResult.criticalPathLatencyMs,
      truncatedCallCount: validatedResult.truncatedCallCount,
      inputTokens: validatedResult.inputTokens,
      outputTokens: validatedResult.outputTokens,
      estimatedCostUsd: validatedResult.estimatedCostUsd,
      llmCalls: validatedResult.llmCalls,
      messageCount: validatedResult.messageCount,
      storedAt,
    };
    await this.validatedResults.save(stored);

    const storedFindings: StoredReviewFinding[] = validatedResult.findings.map(
      (finding) => ({
        ...finding,
        experimentId,
        architecture: validatedResult.architecture,
        storedAt,
      }),
    );
    if (storedFindings.length > 0) {
      await this.findings.saveMany(storedFindings);
    }

    this.logger.info("Stored validated result", {
      experimentId,
      architecture: validatedResult.architecture,
      findings: storedFindings.length,
    });
  }

  public async getExperimentResult(
    experimentId: string,
  ): Promise<StoredExperimentResult | null> {
    const [rawResult, validatedResult, findings] = await Promise.all([
      this.rawResults.getByExperimentId(experimentId),
      this.validatedResults.getByExperimentId(experimentId),
      this.findings.getByExperimentId(experimentId),
    ]);

    if (!rawResult && !validatedResult && findings.length === 0) {
      return null;
    }
    return { experimentId, rawResult, validatedResult, findings };
  }
}
