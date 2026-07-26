import type { ReviewArchitecture } from "../models/experiment.ts";
import type { ExperimentService } from "../services/experiment/experiment-service.ts";
import type { IStorageEngine } from "../storage/storage-engine.ts";
import type { StoredExperimentResult } from "../storage/stored-models.ts";
import type { IEvaluationEngine } from "../evaluation/index.ts";
import type { ExperimentMetrics } from "../evaluation/index.ts";
import type {
  BenchmarkInstance,
  BenchmarkRun,
  BenchmarkResult,
  GroundTruthEvaluator,
} from "../benchmark/index.ts";

import { BenchmarkRunError } from "../benchmark/index.ts";

/** The controlled experiment versions held constant across the campaign. */
export interface ExecutionVersions {
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly workflowVersion: string;
  readonly evaluationVersion: string;
}

/** One unit of campaign work: one architecture reviewing one instance, once. */
export interface ExecutionInput {
  readonly datasetId: string;
  readonly instance: BenchmarkInstance;
  /**
   * The snapshot the instance was imported into. The runner imports each
   * instance exactly once and passes the shared id here, so all three
   * architectures review the identical snapshot (the fairness requirement).
   */
  readonly snapshotId: string;
  readonly architecture: ReviewArchitecture;
  readonly run: number;
}

/** Everything produced by executing one run — inputs for manifest + exports. */
export interface ExecutionOutcome {
  readonly datasetId: string;
  readonly instanceId: string;
  readonly architecture: ReviewArchitecture;
  readonly run: number;
  readonly snapshotId: string;
  readonly experimentId: string;
  readonly stored: StoredExperimentResult;
  readonly benchmarkRun: BenchmarkRun;
  readonly benchmarkResult: BenchmarkResult;
  readonly metrics: ExperimentMetrics;
}

/** Executes a single campaign run. Injectable so the runner can be tested. */
export interface IExperimentExecutor {
  execute(input: ExecutionInput): Promise<ExecutionOutcome>;
}

export interface ExperimentExecutorDependencies {
  readonly experimentService: ExperimentService;
  readonly storage: IStorageEngine;
  readonly evaluationEngine: IEvaluationEngine;
  readonly groundTruthEvaluator: GroundTruthEvaluator;
  readonly versions: ExecutionVersions;
}

/**
 * Executes one benchmark run against an already-imported snapshot through the
 * *existing* pipeline — Experiment (→ Validation → Storage internally) →
 * Evaluation → Ground Truth — and returns the artifacts. It adds no review
 * logic and computes no new metric; it only orchestrates the services.
 *
 * The runner supplies a single shared `snapshotId` per instance, so the three
 * architectures review the identical snapshot — preserving the fairness
 * requirement that only the architecture varies.
 */
export class ExperimentExecutor implements IExperimentExecutor {
  private readonly deps: ExperimentExecutorDependencies;

  public constructor(deps: ExperimentExecutorDependencies) {
    this.deps = deps;
  }

  public async execute(input: ExecutionInput): Promise<ExecutionOutcome> {
    const { experimentService, storage, evaluationEngine, groundTruthEvaluator, versions } =
      this.deps;
    const { instance, snapshotId, architecture, run, datasetId } = input;

    const result = await experimentService.runExperiment({
      snapshotId,
      architecture,
      modelVersion: versions.modelVersion,
      promptVersion: versions.promptVersion,
      workflowVersion: versions.workflowVersion,
      evaluationVersion: versions.evaluationVersion,
      // Repeated runs (run > 1) must be fresh experiments, not idempotent reuse.
      forceRerun: run > 1,
    });

    if (result.status !== "completed") {
      // Include the underlying error so RetryPolicy can classify transient
      // failures (e.g. Bedrock throttling) as retryable rather than terminal.
      throw new BenchmarkRunError(
        `Experiment "${result.experimentId}" for ${instance.instanceId} (${architecture}) ` +
          `ended in status "${result.status}"${result.error ? `: ${result.error}` : ""}.`,
      );
    }

    const stored = await storage.getExperimentResult(result.experimentId);
    if (!stored || !stored.validatedResult) {
      throw new BenchmarkRunError(
        `No validated result stored for experiment "${result.experimentId}".`,
      );
    }

    const benchmarkRun: BenchmarkRun = {
      runId: `${instance.instanceId}#${architecture}#${run}`,
      datasetId,
      instanceId: instance.instanceId,
      snapshotId,
      experimentId: result.experimentId,
      architecture,
      producedFindings: stored.validatedResult.findings,
      groundTruth: instance.groundTruth,
    };

    const benchmarkResult = groundTruthEvaluator.evaluate(benchmarkRun);
    const metrics = evaluationEngine.evaluate(stored);

    return {
      datasetId,
      instanceId: instance.instanceId,
      architecture,
      run,
      snapshotId,
      experimentId: result.experimentId,
      stored,
      benchmarkRun,
      benchmarkResult,
      metrics,
    };
  }
}
