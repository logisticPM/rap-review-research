import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CampaignRunner,
  InMemoryManifestStore,
  manifestEntryKey,
} from "../../src/campaign/index.ts";
import type { CampaignConfig, ExecutionOutcome } from "../../src/campaign/index.ts";
import type { IPRImportService } from "../../src/services/snapshot/pr-import-service.ts";
import type { ReviewArchitecture } from "../../src/models/experiment.ts";
import { FixedClock } from "../../src/shared/clock.ts";
import {
  EXECUTION_CONFIG,
  buildBenchmarkPipeline,
  loadSampleDatasets,
} from "../../scripts/benchmark-shared.ts";

/**
 * Wraps a real IPRImportService so the test can count how many times each
 * instance is actually imported. The runner never passes instanceId to
 * importManualDiff (only title/source/rawDiff), so calls are attributed back
 * to an instance via its (unique) fixture title.
 */
function wrapImportServiceWithCounter(
  inner: IPRImportService,
  titleToInstanceId: Map<string, string>,
): { service: IPRImportService; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const service: IPRImportService = {
    async importManualDiff(input) {
      const instanceId = titleToInstanceId.get(input.title) ?? input.title;
      counts.set(instanceId, (counts.get(instanceId) ?? 0) + 1);
      return inner.importManualDiff(input);
    },
  };
  return { service, counts };
}

/**
 * Strip the allocation-order-dependent identifiers (snapshotId/experimentId —
 * these are assigned in call order via DefaultSnapshotIdGenerator, so two
 * independently-imported runs may legitimately allocate them differently when
 * concurrency reorders imports) and keep only the scientifically meaningful
 * content: the findings and the ground-truth metrics.
 */
function normalizeOutcome(outcome: ExecutionOutcome) {
  const findings = outcome.stored?.validatedResult?.findings ?? [];
  const r = outcome.benchmarkResult;
  return {
    findings: findings.map((f) => ({
      title: f.title,
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      description: f.description,
      recommendation: f.recommendation,
      confidence: f.confidence,
    })),
    metrics: {
      groundTruthCount: r.groundTruthCount,
      producedCount: r.producedCount,
      uniqueProducedCount: r.uniqueProducedCount,
      truePositives: r.truePositives,
      falsePositives: r.falsePositives,
      falseNegatives: r.falseNegatives,
      precision: r.precision,
      uniquePrecision: r.uniquePrecision,
      recall: r.recall,
      f1: r.f1,
      localizationAccuracy: r.localizationAccuracy,
      snippetLocalizationAccuracy: r.snippetLocalizationAccuracy,
    },
  };
}

const ARCHITECTURES: ReviewArchitecture[] = [
  "agentless",
  "generalists-3",
  "hierarchical",
  "consensus",
];
const RUNS_PER_INSTANCE = 3;

function buildConfig(campaignId: string, maxConcurrency?: number): CampaignConfig {
  return {
    campaignId,
    modelVersion: EXECUTION_CONFIG.modelVersion,
    promptVersion: EXECUTION_CONFIG.promptVersion,
    workflowVersion: EXECUTION_CONFIG.workflowVersion,
    evaluationVersion: EXECUTION_CONFIG.evaluationVersion,
    architectures: [...ARCHITECTURES],
    runsPerInstance: RUNS_PER_INSTANCE,
    generatedAt: "2026-07-13T00:00:00.000Z",
    maxConcurrency,
  };
}

// Full campaign, all four architectures, mock provider throughout (no
// Bedrock, deterministic, free) — run once sequentially (today's untouched
// path) and once through the bounded-concurrency pool, on independent
// pipelines, and assert the results are equivalent.
test("bounded concurrency (maxConcurrency: 4) is equivalent to sequential execution (maxConcurrency unset)", async () => {
  const { qodo, swe } = loadSampleDatasets();
  const datasets = [qodo, swe];

  const titleToInstanceId = new Map<string, string>();
  for (const dataset of datasets) {
    for (const instance of dataset.instances) {
      titleToInstanceId.set(instance.title, instance.instanceId);
    }
  }
  const instanceCount = titleToInstanceId.size;
  assert.ok(
    instanceCount >= 3,
    `expected at least 3 instances in the fixtures, found ${instanceCount}`,
  );
  const expectedEntries = instanceCount * ARCHITECTURES.length * RUNS_PER_INSTANCE;

  // --- Sequential run: maxConcurrency unset -> defaults to 1, the original,
  // untouched code path. ---
  const seqPipeline = buildBenchmarkPipeline();
  const { service: seqImportService, counts: seqImportCounts } =
    wrapImportServiceWithCounter(seqPipeline.importService, titleToInstanceId);
  const seqRunner = new CampaignRunner({
    importService: seqImportService,
    experimentService: seqPipeline.experimentService,
    storage: seqPipeline.storage,
    manifestStore: new InMemoryManifestStore(),
    clock: new FixedClock(),
  });
  const seqReport = await seqRunner.run(datasets, buildConfig("concurrency-consistency-seq"));

  // --- Concurrent run: maxConcurrency: 4, worker-pool path, fresh pipeline. ---
  const conPipeline = buildBenchmarkPipeline();
  const { service: conImportService, counts: conImportCounts } =
    wrapImportServiceWithCounter(conPipeline.importService, titleToInstanceId);
  const conRunner = new CampaignRunner({
    importService: conImportService,
    experimentService: conPipeline.experimentService,
    storage: conPipeline.storage,
    manifestStore: new InMemoryManifestStore(),
    clock: new FixedClock(),
  });
  const conReport = await conRunner.run(datasets, buildConfig("concurrency-consistency-con", 4));

  // Same manifest size in both.
  assert.equal(seqReport.manifest.entries.length, expectedEntries);
  assert.equal(conReport.manifest.entries.length, expectedEntries);

  // Same number of outcomes — nothing dropped, nothing duplicated by the pool.
  assert.equal(seqReport.outcomes.length, expectedEntries);
  assert.equal(conReport.outcomes.length, expectedEntries);

  // Every manifest entry reached "completed" in both runs.
  for (const entry of seqReport.manifest.entries) {
    assert.equal(
      entry.status,
      "completed",
      `sequential entry ${manifestEntryKey(entry)} did not complete`,
    );
  }
  for (const entry of conReport.manifest.entries) {
    assert.equal(
      entry.status,
      "completed",
      `concurrent entry ${manifestEntryKey(entry)} did not complete`,
    );
  }

  // --- Import-once invariant: each instance imported EXACTLY once, per run. ---
  assert.equal(seqImportCounts.size, instanceCount);
  assert.equal(conImportCounts.size, instanceCount);
  for (const [instanceId, count] of seqImportCounts) {
    assert.equal(count, 1, `sequential run imported "${instanceId}" ${count} times`);
  }
  for (const [instanceId, count] of conImportCounts) {
    assert.equal(count, 1, `concurrent run imported "${instanceId}" ${count} times`);
  }

  // --- Same set of completed experiment keys (order-independent), no dupes. ---
  const seqKeys = new Set(seqReport.outcomes.map((o) => manifestEntryKey(o)));
  const conKeys = new Set(conReport.outcomes.map((o) => manifestEntryKey(o)));
  assert.equal(seqReport.outcomes.length, seqKeys.size, "duplicate outcome key in sequential run");
  assert.equal(conReport.outcomes.length, conKeys.size, "duplicate outcome key in concurrent run");
  assert.equal(seqKeys.size, expectedEntries);
  assert.deepEqual([...conKeys].sort(), [...seqKeys].sort());

  // --- Same per-experiment findings/results content for every key. ---
  const seqByKey = new Map(seqReport.outcomes.map((o) => [manifestEntryKey(o), o]));
  const conByKey = new Map(conReport.outcomes.map((o) => [manifestEntryKey(o), o]));
  for (const key of seqKeys) {
    const seqOutcome = seqByKey.get(key);
    const conOutcome = conByKey.get(key);
    assert.ok(seqOutcome, `missing sequential outcome for ${key}`);
    assert.ok(conOutcome, `missing concurrent outcome for ${key}`);
    assert.deepEqual(
      normalizeOutcome(conOutcome!),
      normalizeOutcome(seqOutcome!),
      `outcome content diverged between sequential and concurrent runs for ${key}`,
    );
  }

  // --- Per-architecture summary is equivalent too. ---
  assert.deepEqual(
    conReport.summary.perArchitecture.map((s) => s.architecture).sort(),
    seqReport.summary.perArchitecture.map((s) => s.architecture).sort(),
  );
  assert.equal(conReport.summary.progress.completed, seqReport.summary.progress.completed);
  assert.equal(conReport.summary.progress.failed, seqReport.summary.progress.failed);
});

// maxConcurrency: 1 must be indistinguishable from leaving it unset — both
// take the untouched sequential branch.
test("maxConcurrency: 1 behaves identically to maxConcurrency unset", async () => {
  const { qodo } = loadSampleDatasets();
  const datasets = [qodo];

  const unsetPipeline = buildBenchmarkPipeline();
  const unsetRunner = new CampaignRunner({
    importService: unsetPipeline.importService,
    experimentService: unsetPipeline.experimentService,
    storage: unsetPipeline.storage,
    manifestStore: new InMemoryManifestStore(),
    clock: new FixedClock(),
  });
  const unsetReport = await unsetRunner.run(
    datasets,
    buildConfig("concurrency-consistency-unset"),
  );

  const explicitPipeline = buildBenchmarkPipeline();
  const explicitRunner = new CampaignRunner({
    importService: explicitPipeline.importService,
    experimentService: explicitPipeline.experimentService,
    storage: explicitPipeline.storage,
    manifestStore: new InMemoryManifestStore(),
    clock: new FixedClock(),
  });
  const explicitReport = await explicitRunner.run(
    datasets,
    buildConfig("concurrency-consistency-explicit-1", 1),
  );

  assert.deepEqual(
    explicitReport.manifest.entries.map((e) => ({ ...e })),
    unsetReport.manifest.entries.map((e) => ({ ...e })),
  );
  assert.equal(explicitReport.outcomes.length, unsetReport.outcomes.length);
  assert.equal(explicitReport.exports.benchmarkCsv, unsetReport.exports.benchmarkCsv);
});
