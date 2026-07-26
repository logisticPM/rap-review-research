import type {
  Experiment,
  ExperimentStatus,
  RunExperimentInput,
  RunExperimentResult,
  ExperimentCompletionSummary,
} from "../../models/experiment.ts";
import type { RawReviewResult } from "../../models/review-result.ts";
import type { ArchitectureRegistry } from "../../architectures/review-architecture.ts";
import type { ExperimentRepository } from "../../repositories/experiment-repository.ts";
import type { SnapshotRepository } from "../../repositories/snapshot-repository.ts";
import type { Clock } from "../../shared/clock.ts";
import type { IdGenerator } from "../../shared/id.ts";
import type { Logger, LogContext } from "../../shared/logger.ts";
import type { IStorageEngine } from "../../storage/storage-engine.ts";
import type { IOutputValidator, IEvaluationTrigger } from "./ports.ts";

import { buildIdempotencyKey } from "../../shared/id.ts";
import {
  ExperimentNotFoundError,
  SnapshotNotFoundError,
} from "../../shared/errors.ts";

/**
 * The public contract of the Experiment Engine.
 */
export interface IExperimentEngine {
  run(input: RunExperimentInput): Promise<RunExperimentResult>;
  retry(experimentId: string): Promise<RunExperimentResult>;
  getStatus(experimentId: string): Promise<ExperimentStatus>;
}

/**
 * Collaborators required by the {@link ExperimentEngine}. All are injected
 * (constructor dependency injection) so the engine depends only on interfaces.
 */
export interface ExperimentEngineDependencies {
  readonly experiments: ExperimentRepository;
  readonly snapshots: SnapshotRepository;
  readonly registry: ArchitectureRegistry;
  readonly storage: IStorageEngine;
  readonly validator: IOutputValidator;
  readonly evaluator: IEvaluationTrigger;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
}

/**
 * The core runtime of the platform.
 *
 * Responsibilities (RFC-01 scope):
 *  - create experiment records and enforce idempotency;
 *  - manage the experiment lifecycle / state machine;
 *  - resolve the requested review architecture via the registry;
 *  - execute the architecture and capture execution-level metrics;
 *  - hand raw output to the validation port and trigger the evaluation port;
 *  - report execution results.
 *
 * Non-responsibilities: it performs no code review, no diff parsing, no schema
 * validation, no metric computation, and no direct storage/provider access.
 * Those belong to other modules and are reached only through injected ports.
 *
 * Dependencies: see {@link ExperimentEngineDependencies}.
 */
export class ExperimentEngine implements IExperimentEngine {
  private readonly deps: ExperimentEngineDependencies;

  public constructor(deps: ExperimentEngineDependencies) {
    this.deps = deps;
  }

  /**
   * Create (or reuse) and execute an experiment, enforcing the idempotency
   * rules defined by the specification.
   */
  public async run(input: RunExperimentInput): Promise<RunExperimentResult> {
    const key = buildIdempotencyKey(input);

    if (input.forceRerun) {
      const record = this.buildExperimentRecord(input, key, true);
      await this.deps.experiments.create(record);
      return this.executeExperiment(record);
    }

    const existing = await this.deps.experiments.findByIdempotencyKey(key);
    if (existing) {
      return this.handleExisting(existing);
    }

    const record = this.buildExperimentRecord(input, key, false);
    await this.deps.experiments.create(record);
    return this.executeExperiment(record);
  }

  /**
   * Retry a previously created experiment. Only `failed` (or never-executed
   * `created`) experiments are re-run; terminal/in-flight experiments are
   * returned as-is.
   */
  public async retry(experimentId: string): Promise<RunExperimentResult> {
    const experiment = await this.deps.experiments.findById(experimentId);
    if (!experiment) {
      throw new ExperimentNotFoundError(
        `Experiment "${experimentId}" does not exist.`,
      );
    }

    if (experiment.status === "failed" || experiment.status === "created") {
      return this.executeExperiment(experiment);
    }

    return {
      experimentId: experiment.experimentId,
      status: experiment.status,
      reusedExisting: true,
    };
  }

  /** Return the current lifecycle status of an experiment. */
  public async getStatus(experimentId: string): Promise<ExperimentStatus> {
    const experiment = await this.deps.experiments.findById(experimentId);
    if (!experiment) {
      throw new ExperimentNotFoundError(
        `Experiment "${experimentId}" does not exist.`,
      );
    }
    return experiment.status;
  }

  /** Apply the idempotency rules to an already-existing experiment. */
  private async handleExisting(
    experiment: Experiment,
  ): Promise<RunExperimentResult> {
    if (experiment.status === "failed" || experiment.status === "created") {
      // Failed experiments may be retried; a created-but-unrun record resumes.
      return this.executeExperiment(experiment);
    }
    // completed / queued / running / validating / evaluating: reuse as-is.
    this.deps.logger.info("Reusing existing experiment", {
      experimentId: experiment.experimentId,
      snapshotId: experiment.snapshotId,
      architecture: experiment.architecture,
      status: experiment.status,
    });
    return {
      experimentId: experiment.experimentId,
      status: experiment.status,
      reusedExisting: true,
    };
  }

  /** Drive one experiment through the full execution lifecycle. */
  private async executeExperiment(
    experiment: Experiment,
  ): Promise<RunExperimentResult> {
    const ctx: LogContext = {
      experimentId: experiment.experimentId,
      snapshotId: experiment.snapshotId,
      architecture: experiment.architecture,
    };

    try {
      const startedAt = this.deps.clock.nowIso();
      await this.transition(experiment.experimentId, "queued", ctx);
      await this.transition(experiment.experimentId, "running", ctx);

      const raw = await this.runArchitecture(experiment);

      // Preserve the raw result immediately — even if validation later fails.
      await this.deps.storage.storeRawResult({
        experimentId: experiment.experimentId,
        rawResult: raw,
      });

      await this.transition(experiment.experimentId, "validating", ctx);
      const validated = await this.deps.validator.validate(raw, {
        experimentId: experiment.experimentId,
        promptVersion: experiment.promptVersion,
      });

      // Validation passed — persist the validated result and its findings.
      await this.deps.storage.storeValidatedResult({
        experimentId: experiment.experimentId,
        validatedResult: validated,
      });

      await this.transition(experiment.experimentId, "evaluating", ctx);
      await this.deps.evaluator.evaluate(experiment.experimentId, validated);

      const summary = this.buildCompletionSummary(raw, startedAt);
      await this.deps.experiments.markCompleted(
        experiment.experimentId,
        summary,
      );
      this.deps.logger.info("Experiment completed", {
        ...ctx,
        status: "completed",
      });

      return {
        experimentId: experiment.experimentId,
        status: "completed",
        reusedExisting: false,
      };
    } catch (error) {
      return this.failExperiment(experiment.experimentId, ctx, error);
    }
  }

  /** Resolve the architecture, load the snapshot, and execute the review. */
  private async runArchitecture(
    experiment: Experiment,
  ): Promise<RawReviewResult> {
    const snapshot = await this.deps.snapshots.getById(experiment.snapshotId);
    if (!snapshot) {
      throw new SnapshotNotFoundError(
        `PR Snapshot "${experiment.snapshotId}" does not exist.`,
      );
    }

    // May throw UnknownArchitectureError — handled as a (non-retryable) failure.
    const architecture = this.deps.registry.get(experiment.architecture);

    return architecture.execute({
      experimentId: experiment.experimentId,
      snapshot,
      modelVersion: experiment.modelVersion,
      promptVersion: experiment.promptVersion,
      workflowVersion: experiment.workflowVersion,
    });
  }

  /** Record a failure: mark the experiment failed and report the result. */
  private async failExperiment(
    experimentId: string,
    ctx: LogContext,
    error: unknown,
  ): Promise<RunExperimentResult> {
    const message = error instanceof Error ? error.message : String(error);
    await this.deps.experiments.markFailed(experimentId, message);
    this.deps.logger.error("Experiment failed", {
      ...ctx,
      status: "failed",
      error: message,
    });
    return { experimentId, status: "failed", reusedExisting: false, error: message };
  }

  private buildExperimentRecord(
    input: RunExperimentInput,
    key: string,
    isRerun: boolean,
  ): Experiment {
    return {
      experimentId: this.deps.idGenerator.nextExperimentId(key, isRerun),
      snapshotId: input.snapshotId,
      architecture: input.architecture,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      workflowVersion: input.workflowVersion,
      evaluationVersion: input.evaluationVersion,
      status: "created",
      createdAt: this.deps.clock.nowIso(),
    };
  }

  private buildCompletionSummary(
    raw: RawReviewResult,
    startedAt: string,
  ): ExperimentCompletionSummary {
    return {
      startedAt,
      completedAt: this.deps.clock.nowIso(),
      totalLatencyMs: raw.latencyMs,
      totalInputTokens: raw.inputTokens,
      totalOutputTokens: raw.outputTokens,
      estimatedCostUsd: raw.estimatedCostUsd,
      messageCount: raw.messageCount,
    };
  }

  private async transition(
    experimentId: string,
    status: ExperimentStatus,
    ctx: LogContext,
  ): Promise<void> {
    await this.deps.experiments.updateStatus(experimentId, status);
    this.deps.logger.info(`Status → ${status}`, { ...ctx, status });
  }
}
