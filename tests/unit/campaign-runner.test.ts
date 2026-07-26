import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExperimentService } from "../../src/services/experiment/experiment-service.ts";
import type { IPRImportService } from "../../src/services/snapshot/pr-import-service.ts";
import type { IStorageEngine } from "../../src/storage/storage-engine.ts";
import type { StoredExperimentResult } from "../../src/storage/stored-models.ts";
import type { IEvaluationEngine } from "../../src/evaluation/index.ts";
import type { ExperimentMetrics } from "../../src/evaluation/index.ts";
import type { IExportService } from "../../src/export/index.ts";
import type { BenchmarkDataset } from "../../src/benchmark/index.ts";
import type {
  CampaignConfig,
  CampaignRunnerDependencies,
  ExecutionInput,
  ExecutionOutcome,
  IExperimentExecutor,
} from "../../src/campaign/index.ts";

import {
  CampaignRunner,
  InMemoryManifestStore,
} from "../../src/campaign/index.ts";
import { ProviderError, ValidationError } from "../../src/shared/errors.ts";
import { FixedClock } from "../../src/shared/clock.ts";

const DATASET: BenchmarkDataset = {
  datasetId: "qodo",
  name: "Qodo",
  source: "qodo-pr-review-bench",
  instances: [
    { instanceId: "q1", title: "Q1", source: "qodo-pr-review-bench", rawDiff: "d", groundTruth: [] },
  ],
};

const CONFIG: CampaignConfig = {
  campaignId: "c1",
  modelVersion: "m",
  promptVersion: "v1",
  workflowVersion: "w1",
  evaluationVersion: "e1",
  architectures: ["agentless"],
  runsPerInstance: 1,
  generatedAt: "2026-07-02T12:00:00.000Z",
};

class StubExecutor implements IExperimentExecutor {
  public calls = 0;
  private readonly behavior: (input: ExecutionInput, call: number) => Promise<ExecutionOutcome>;
  public constructor(
    behavior: (input: ExecutionInput, call: number) => Promise<ExecutionOutcome>,
  ) {
    this.behavior = behavior;
  }
  public execute(input: ExecutionInput): Promise<ExecutionOutcome> {
    this.calls += 1;
    return this.behavior(input, this.calls);
  }
}

function outcomeFor(input: ExecutionInput): ExecutionOutcome {
  return {
    datasetId: input.datasetId,
    instanceId: input.instance.instanceId,
    architecture: input.architecture,
    run: input.run,
    snapshotId: input.snapshotId,
    experimentId: `exp-${input.instance.instanceId}-${input.architecture}-${input.run}`,
    stored: {} as StoredExperimentResult,
    benchmarkRun: {
      runId: `${input.instance.instanceId}#${input.architecture}#${input.run}`,
      datasetId: input.datasetId,
      instanceId: input.instance.instanceId,
      snapshotId: input.snapshotId,
      experimentId: "exp",
      architecture: input.architecture,
      producedFindings: [],
      groundTruth: input.instance.groundTruth,
    },
    benchmarkResult: {
      runId: `${input.instance.instanceId}#${input.architecture}#${input.run}`,
      datasetId: input.datasetId,
      instanceId: input.instance.instanceId,
      snapshotId: input.snapshotId,
      experimentId: "exp",
      architecture: input.architecture,
      groundTruthCount: 0,
      producedCount: 0,
      uniqueProducedCount: 0,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 0,
      uniquePrecision: 0,
      recall: 0,
      f1: 0,
      localizationAccuracy: 0,
      snippetLocalizationAccuracy: 0,
    },
    metrics: {} as ExperimentMetrics,
  };
}

const importService: IPRImportService = {
  async importManualDiff() {
    return { snapshotId: "snap-q1", reusedExisting: false };
  },
};

const storage: IStorageEngine = {
  async storeRawResult() {},
  async storeValidatedResult() {},
  async getExperimentResult() {
    return null;
  },
};

const evaluationEngine: IEvaluationEngine = {
  evaluate: () => ({}) as ExperimentMetrics,
  evaluateBatch: () => [],
  evaluateIndustrial: () => [],
  evaluateBatchIndustrial: () => [],
};

const exportService: IExportService = {
  async exportComparisons(_input, format) {
    return { format, fileName: `f.${format}`, content: "", rowCount: 0, generatedAt: "t" };
  },
};

function baseDeps(executor: IExperimentExecutor): CampaignRunnerDependencies {
  return {
    importService,
    experimentService: {} as ExperimentService,
    storage,
    evaluationEngine,
    exportService,
    executor,
    clock: new FixedClock(),
    retryBackoffMs: 0, // no real waits in tests
  };
}

test("retries a transient failure and then completes", async () => {
  const executor = new StubExecutor(async (input, call) => {
    if (call === 1) {
      throw new ProviderError("throttled");
    }
    return outcomeFor(input);
  });
  const report = await new CampaignRunner(baseDeps(executor)).run([DATASET], CONFIG);

  assert.equal(executor.calls, 2); // one failed attempt + one success
  assert.equal(report.summary.progress.completed, 1);
  assert.equal(report.summary.progress.failed, 0);
  const entry = report.manifest.entries[0]!;
  assert.equal(entry.status, "completed");
  assert.equal(entry.attempts, 2);
  assert.ok(report.logs.some((l) => l.includes("run-retry")));
});

test("records a terminal failure without aborting the campaign", async () => {
  const executor = new StubExecutor(async () => {
    throw new ValidationError("bad schema");
  });
  const report = await new CampaignRunner(baseDeps(executor)).run([DATASET], CONFIG);

  assert.equal(executor.calls, 1); // not retried
  assert.equal(report.summary.progress.failed, 1);
  assert.equal(report.manifest.entries[0]!.status, "failed");
  assert.equal(report.summary.failures.length, 1);
});

test("resumes a completed campaign without re-executing", async () => {
  const store = new InMemoryManifestStore();
  const executor = new StubExecutor(async (input) => outcomeFor(input));
  const deps = { ...baseDeps(executor), manifestStore: store };

  const first = await new CampaignRunner(deps).run([DATASET], CONFIG);
  assert.equal(executor.calls, 1);
  assert.equal(first.summary.progress.completed, 1);

  // Second run with the same store: the completed entry is skipped.
  const second = await new CampaignRunner(deps).run([DATASET], CONFIG);
  assert.equal(executor.calls, 1); // unchanged — nothing re-executed
  assert.equal(second.summary.progress.completed, 1);
  assert.equal(second.summary.progress.pending, 0);
});
