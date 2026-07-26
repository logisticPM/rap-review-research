import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewArchitecture } from "../../src/models/experiment.ts";
import type { ExecutionOutcome } from "../../src/campaign/index.ts";
import type { BenchmarkResult } from "../../src/benchmark/index.ts";
import type { StoredExperimentResult } from "../../src/storage/stored-models.ts";
import type { ExperimentMetrics } from "../../src/evaluation/index.ts";

import { Manifest, buildCampaignSummary } from "../../src/campaign/index.ts";

function benchmarkResult(
  architecture: ReviewArchitecture,
  instanceId: string,
  recall: number,
): BenchmarkResult {
  return {
    runId: `${instanceId}#${architecture}#1`,
    datasetId: "qodo",
    instanceId,
    snapshotId: "snap",
    experimentId: "exp",
    architecture,
    groundTruthCount: 1,
    producedCount: 1,
    uniqueProducedCount: 1,
    truePositives: recall,
    falsePositives: 0,
    falseNegatives: 1 - recall,
    precision: recall,
    uniquePrecision: recall,
    recall,
    f1: recall,
    localizationAccuracy: recall,
    snippetLocalizationAccuracy: recall,
  };
}

function outcome(
  architecture: ReviewArchitecture,
  instanceId: string,
  recall: number,
  truncatedCalls = 0,
): ExecutionOutcome {
  return {
    datasetId: "qodo",
    instanceId,
    architecture,
    run: 1,
    snapshotId: "snap",
    experimentId: "exp",
    stored: {} as StoredExperimentResult,
    benchmarkRun: {
      runId: `${instanceId}#${architecture}#1`,
      datasetId: "qodo",
      instanceId,
      snapshotId: "snap",
      experimentId: "exp",
      architecture,
      producedFindings: [],
      groundTruth: [],
    },
    benchmarkResult: benchmarkResult(architecture, instanceId, recall),
    metrics: {
      architecture,
      operationalCost: { truncatedCallCount: truncatedCalls },
    } as ExperimentMetrics,
  };
}

test("summarizes progress, per-architecture means, coverage, and failures", () => {
  const manifest = new Manifest({
    campaignId: "c1",
    createdAt: "t",
    modelVersion: "m",
    promptVersion: "v1",
    workflowVersion: "w1",
    evaluationVersion: "e1",
    entries: [
      { datasetId: "qodo", instanceId: "q1", architecture: "agentless", run: 1, status: "completed", attempts: 1 },
      { datasetId: "qodo", instanceId: "q1", architecture: "hierarchical", run: 1, status: "completed", attempts: 1 },
      { datasetId: "qodo", instanceId: "q1", architecture: "consensus", run: 1, status: "failed", attempts: 3, error: "boom" },
    ],
  });

  const outcomes = [
    outcome("agentless", "q1", 0),
    outcome("hierarchical", "q1", 1),
  ];

  const summary = buildCampaignSummary({
    manifest,
    outcomes,
    startedAt: "t0",
    finishedAt: "t1",
  });

  assert.equal(summary.progress.completed, 2);
  assert.equal(summary.progress.failed, 1);

  const hier = summary.perArchitecture.find((s) => s.architecture === "hierarchical");
  assert.equal(hier?.meanRecall, 1);
  const agentless = summary.perArchitecture.find((s) => s.architecture === "agentless");
  assert.equal(agentless?.meanRecall, 0);

  assert.deepEqual(summary.datasets, [
    { datasetId: "qodo", instanceCount: 1, completedRuns: 2 },
  ]);

  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0]!.architecture, "consensus");
  assert.equal(summary.failures[0]!.attempts, 3);
  assert.equal(summary.failures[0]!.error, "boom");
});

test("reports per-architecture truncation rate (B2)", () => {
  const manifest = new Manifest({
    campaignId: "c1",
    createdAt: "t",
    modelVersion: "m",
    promptVersion: "v1",
    workflowVersion: "w1",
    evaluationVersion: "e1",
    entries: [],
  });
  // agentless: 2 runs, one truncated → 0.5; hierarchical: 2 runs, none → 0.
  const outcomes = [
    outcome("agentless", "q1", 1, 1),
    outcome("agentless", "q2", 1, 0),
    outcome("hierarchical", "q1", 1, 0),
    outcome("hierarchical", "q2", 1, 0),
  ];
  const summary = buildCampaignSummary({ manifest, outcomes });

  const agentless = summary.truncation.find((t) => t.architecture === "agentless");
  assert.equal(agentless?.runs, 2);
  assert.equal(agentless?.truncatedRuns, 1);
  assert.equal(agentless?.totalTruncatedCalls, 1);
  assert.equal(agentless?.truncationRate, 0.5);

  const hier = summary.truncation.find((t) => t.architecture === "hierarchical");
  assert.equal(hier?.truncatedRuns, 0);
  assert.equal(hier?.truncationRate, 0);
});
