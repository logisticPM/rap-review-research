import type { ReviewArchitecture } from "../models/experiment.ts";
import type { ExperimentService } from "../services/experiment/experiment-service.ts";
import type { IStorageEngine } from "../storage/storage-engine.ts";
import type { BenchmarkDataset } from "./models/benchmark-dataset.ts";
import type { BenchmarkRun } from "./models/benchmark-run.ts";
import type { ImportedBenchmarkInstance } from "./benchmark-importer.ts";

import { BenchmarkRunError } from "./benchmark-errors.ts";

/** Experiment version metadata held constant across the benchmark (RFC-13 E4). */
export interface BenchmarkExecutionConfig {
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly workflowVersion: string;
  readonly evaluationVersion: string;
  /** Architectures to run per instance. Defaults to all three. */
  readonly architectures?: ReviewArchitecture[];
}

export interface BenchmarkRunnerDependencies {
  readonly experimentService: ExperimentService;
  readonly storage: IStorageEngine;
  readonly config: BenchmarkExecutionConfig;
}

const ALL_ARCHITECTURES: readonly ReviewArchitecture[] = [
  "agentless",
  "hierarchical",
  "consensus",
];

/**
 * Runs imported benchmark instances through the review architectures and
 * collects each architecture's produced findings into {@link BenchmarkRun}s.
 *
 * Every instance is reviewed by **all** configured architectures (default: all
 * three), so the cross-architecture comparison is preserved by construction. It
 * holds no review logic — it delegates to the Experiment Engine (which the
 * architecture registry backs) and reads the stored validated findings.
 */
export class BenchmarkRunner {
  private readonly experimentService: ExperimentService;
  private readonly storage: IStorageEngine;
  private readonly config: BenchmarkExecutionConfig;

  public constructor(deps: BenchmarkRunnerDependencies) {
    this.experimentService = deps.experimentService;
    this.storage = deps.storage;
    this.config = deps.config;
  }

  public async run(
    dataset: BenchmarkDataset,
    imported: ImportedBenchmarkInstance[],
  ): Promise<BenchmarkRun[]> {
    const architectures = this.config.architectures ?? [...ALL_ARCHITECTURES];
    const runs: BenchmarkRun[] = [];

    for (const { instance, snapshotId } of imported) {
      for (const architecture of architectures) {
        const result = await this.experimentService.runExperiment({
          snapshotId,
          architecture,
          modelVersion: this.config.modelVersion,
          promptVersion: this.config.promptVersion,
          workflowVersion: this.config.workflowVersion,
          evaluationVersion: this.config.evaluationVersion,
        });
        if (result.status !== "completed") {
          throw new BenchmarkRunError(
            `Experiment "${result.experimentId}" for instance "${instance.instanceId}" ` +
              `(${architecture}) did not complete: ${result.status}.`,
          );
        }

        const stored = await this.storage.getExperimentResult(result.experimentId);
        const producedFindings = stored?.validatedResult?.findings ?? [];

        runs.push({
          runId: `${instance.instanceId}#${architecture}`,
          datasetId: dataset.datasetId,
          instanceId: instance.instanceId,
          snapshotId,
          experimentId: result.experimentId,
          architecture,
          producedFindings,
          groundTruth: instance.groundTruth,
          rawDiff: instance.rawDiff,
        });
      }
    }
    return runs;
  }
}
