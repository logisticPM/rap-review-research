import type { ReviewArchitecture } from "../models/experiment.ts";
import type { IPRImportService } from "../services/snapshot/pr-import-service.ts";
import type { ExperimentService } from "../services/experiment/experiment-service.ts";
import type { IStorageEngine } from "../storage/storage-engine.ts";
import type { IEvaluationEngine } from "../evaluation/index.ts";
import type { IExportService } from "../export/index.ts";
import type { BenchmarkDataset } from "../benchmark/index.ts";
import type { Clock } from "../shared/clock.ts";

import type {
  CampaignManifestData,
  ManifestEntry,
  ManifestStore,
} from "./manifest.ts";
import type { LoadedInstance } from "./benchmark-loader.ts";
import type {
  IExperimentExecutor,
  ExecutionOutcome,
} from "./experiment-executor.ts";
import type { CampaignSummary } from "./campaign-summary.ts";

import { EvaluationEngine } from "../evaluation/index.ts";
import { createExportService } from "../export/index.ts";
import {
  GroundTruthEvaluator,
  BenchmarkEvaluator,
  BenchmarkCsvExporter,
} from "../benchmark/index.ts";
import { SystemClock } from "../shared/clock.ts";

import { Manifest, manifestEntryKey } from "./manifest.ts";
import { BenchmarkLoader } from "./benchmark-loader.ts";
import { ExperimentExecutor } from "./experiment-executor.ts";
import { RetryPolicy } from "./retry-policy.ts";
import { ProgressReporter } from "./progress-reporter.ts";
import { buildCampaignSummary } from "./campaign-summary.ts";

/**
 * The default architecture set, in the fixed execution order mandated by the
 * runbook (03 §8): Agentless → Hierarchical → Consensus.
 */
export const BENCHMARK_ARCHITECTURES: readonly ReviewArchitecture[] = [
  "agentless",
  "hierarchical",
  "consensus",
];

/** Campaign configuration — the controlled variables and reproducibility metadata. */
export interface CampaignConfig {
  readonly campaignId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly workflowVersion: string;
  readonly evaluationVersion: string;
  /** Architectures to run per instance, in fixed order. Default: all three. */
  readonly architectures?: ReviewArchitecture[];
  /** Independent runs per (instance, architecture). Default: 1. */
  readonly runsPerInstance?: number;
  /**
   * Opt-in bounded concurrency for executing incomplete manifest entries.
   * Default/undefined/1 preserves today's exact sequential behavior — entries
   * run strictly one at a time, in manifest order. When set above 1, up to
   * that many entries run concurrently through a worker-pool (order of
   * completion is no longer deterministic, but the set of outcomes and final
   * manifest are equivalent).
   */
  readonly maxConcurrency?: number;
  /** Timestamp stamped on exports (injected for determinism). */
  readonly generatedAt: string;
  readonly platformVersion?: string;
  readonly gitCommit?: string;
  readonly awsRegion?: string;
}

export interface CampaignRunnerDependencies {
  readonly importService: IPRImportService;
  readonly experimentService: ExperimentService;
  readonly storage: IStorageEngine;
  readonly evaluationEngine?: IEvaluationEngine;
  readonly groundTruthEvaluator?: GroundTruthEvaluator;
  readonly benchmarkEvaluator?: BenchmarkEvaluator;
  readonly benchmarkExporter?: BenchmarkCsvExporter;
  readonly exportService?: IExportService;
  readonly retryPolicy?: RetryPolicy;
  /**
   * Base backoff (ms) between retry attempts; the wait is exponential
   * (`base · 2^(attempt-1)`, capped at 30s) so a Bedrock throttling window has
   * time to clear before re-attempting. Default 2000; set 0 in tests.
   */
  readonly retryBackoffMs?: number;
  readonly reporter?: ProgressReporter;
  readonly manifestStore?: ManifestStore;
  readonly clock?: Clock;
  readonly loader?: BenchmarkLoader;
  /** Injectable for testing; defaults to a real {@link ExperimentExecutor}. */
  readonly executor?: IExperimentExecutor;
}

/** The campaign-level exports (strings — no files written by the core). */
export interface CampaignExports {
  readonly benchmarkCsv: string;
  readonly comparisonsCsv: string;
  readonly comparisonsJson: string;
  readonly campaignJson: string;
}

/** Everything a campaign produces. */
export interface CampaignReport {
  readonly manifest: CampaignManifestData;
  readonly summary: CampaignSummary;
  readonly outcomes: ExecutionOutcome[];
  readonly exports: CampaignExports;
  readonly logs: string[];
}

/**
 * Orchestrates an entire benchmark campaign (experiment plan 01, runbook 03).
 *
 * For every benchmark instance it executes Agentless, Hierarchical, and
 * Consensus (in fixed order) through the existing pipeline, tracking progress,
 * recording reproducible metadata in a manifest, retrying transient failures,
 * and resuming from a persisted manifest. It generates a summary and
 * campaign-level CSV/JSON. It **only orchestrates** — every metric and export is
 * produced by the existing services (RFC-07/10/13), unchanged.
 */
export class CampaignRunner {
  private readonly deps: CampaignRunnerDependencies;
  private readonly loader: BenchmarkLoader;
  private readonly evaluationEngine: IEvaluationEngine;
  private readonly benchmarkEvaluator: BenchmarkEvaluator;
  private readonly benchmarkExporter: BenchmarkCsvExporter;
  private readonly exportService: IExportService;
  private readonly retryPolicy: RetryPolicy;
  private readonly retryBackoffMs: number;
  private readonly clock: Clock;

  public constructor(deps: CampaignRunnerDependencies) {
    this.deps = deps;
    this.loader = deps.loader ?? new BenchmarkLoader();
    this.evaluationEngine = deps.evaluationEngine ?? new EvaluationEngine();
    this.benchmarkEvaluator = deps.benchmarkEvaluator ?? new BenchmarkEvaluator();
    this.benchmarkExporter = deps.benchmarkExporter ?? new BenchmarkCsvExporter();
    this.exportService = deps.exportService ?? createExportService();
    this.retryPolicy = deps.retryPolicy ?? new RetryPolicy();
    this.retryBackoffMs = deps.retryBackoffMs ?? 2000;
    this.clock = deps.clock ?? new SystemClock();
  }

  public async run(
    datasets: BenchmarkDataset[],
    config: CampaignConfig,
  ): Promise<CampaignReport> {
    const reporter = this.deps.reporter ?? new ProgressReporter();
    const executor = this.deps.executor ?? this.buildExecutor(config);
    const loaded = this.loader.flatten(datasets);
    const instancesById = new Map(loaded.map((l) => [l.instance.instanceId, l]));

    const startedAt = this.clock.nowIso();
    const manifest = await this.prepareManifest(loaded, config);
    reporter.campaignStarted(config.campaignId, manifest.incomplete().length);

    const outcomes: ExecutionOutcome[] = [];
    const snapshotByInstance = new Map<string, string>();

    const maxConcurrency = Math.max(1, config.maxConcurrency ?? 1);
    if (maxConcurrency <= 1) {
      // Sequential — untouched: default/undefined/1 is byte-identical to the
      // pre-concurrency implementation.
      for (const entry of manifest.entries()) {
        if (entry.status === "completed") {
          // Resumed: keep the snapshot so its siblings reuse it (fairness).
          if (entry.snapshotId) {
            snapshotByInstance.set(entry.instanceId, entry.snapshotId);
          }
          continue;
        }
        const loadedInstance = instancesById.get(entry.instanceId);
        if (!loadedInstance) {
          continue; // instance no longer in the dataset subset
        }

        // Import each instance exactly once; all architectures share the snapshot.
        const snapshotId = await this.resolveSnapshot(
          loadedInstance,
          snapshotByInstance,
          reporter,
        );

        const outcome = await this.executeWithRetry(
          entry,
          loadedInstance,
          snapshotId,
          executor,
          manifest,
          reporter,
        );
        if (outcome) {
          outcomes.push(outcome);
        }
      }
    } else {
      // Bounded-concurrency worker pool. Collect the incomplete entries first
      // (mirroring the sequential skip logic exactly), then drain the queue
      // with up to `maxConcurrency` workers running concurrently.
      const pending: Array<{ entry: ManifestEntry; loadedInstance: LoadedInstance }> = [];
      for (const entry of manifest.entries()) {
        if (entry.status === "completed") {
          if (entry.snapshotId) {
            snapshotByInstance.set(entry.instanceId, entry.snapshotId);
          }
          continue;
        }
        const loadedInstance = instancesById.get(entry.instanceId);
        if (!loadedInstance) {
          continue;
        }
        pending.push({ entry, loadedInstance });
      }

      // Per-instance in-flight import promise, so concurrent entries for the
      // same instance await the *same* import instead of racing a check-then-set.
      const snapshotPromises = new Map<string, Promise<string>>();
      let cursor = 0;
      const runWorker = async (): Promise<void> => {
        for (;;) {
          const i = cursor;
          cursor += 1;
          if (i >= pending.length) {
            return;
          }
          const { entry, loadedInstance } = pending[i]!;
          const snapshotId = await this.resolveSnapshotConcurrent(
            loadedInstance,
            snapshotByInstance,
            snapshotPromises,
            reporter,
          );
          const outcome = await this.executeWithRetry(
            entry,
            loadedInstance,
            snapshotId,
            executor,
            manifest,
            reporter,
          );
          if (outcome) {
            outcomes.push(outcome);
          }
        }
      };

      const workerCount = Math.min(maxConcurrency, pending.length);
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    }

    // Fold in outcomes for entries that were already completed on resume.
    await this.reconstructCompletedOutcomes(manifest, instancesById, outcomes);

    const finishedAt = this.clock.nowIso();
    const summary = buildCampaignSummary({
      manifest,
      outcomes,
      startedAt,
      finishedAt,
      benchmarkEvaluator: this.benchmarkEvaluator,
    });
    reporter.campaignFinished(manifest.progress());

    const exports = await this.buildExports(manifest, summary, outcomes, config);

    return {
      manifest: manifest.toJSON(),
      summary,
      outcomes,
      exports,
      logs: reporter.getLogs(),
    };
  }

  /** Build a fresh manifest, overlaying any persisted (resumed) statuses. */
  private async prepareManifest(
    loaded: LoadedInstance[],
    config: CampaignConfig,
  ): Promise<Manifest> {
    const architectures = config.architectures ?? [...BENCHMARK_ARCHITECTURES];
    const runs = Math.max(1, config.runsPerInstance ?? 1);

    const entries: ManifestEntry[] = [];
    for (const { datasetId, instance } of loaded) {
      for (const architecture of architectures) {
        for (let run = 1; run <= runs; run += 1) {
          entries.push({
            datasetId,
            instanceId: instance.instanceId,
            architecture,
            run,
            status: "pending",
            attempts: 0,
          });
        }
      }
    }

    const manifest = new Manifest({
      campaignId: config.campaignId,
      createdAt: this.clock.nowIso(),
      modelVersion: config.modelVersion,
      promptVersion: config.promptVersion,
      workflowVersion: config.workflowVersion,
      evaluationVersion: config.evaluationVersion,
      platformVersion: config.platformVersion,
      gitCommit: config.gitCommit,
      awsRegion: config.awsRegion,
      entries,
    });

    const prior = await this.deps.manifestStore?.load(config.campaignId);
    if (prior) {
      for (const priorEntry of prior.entries) {
        if (priorEntry.status !== "completed") {
          continue;
        }
        manifest.update(manifestEntryKey(priorEntry), {
          status: "completed",
          attempts: priorEntry.attempts,
          snapshotId: priorEntry.snapshotId,
          experimentId: priorEntry.experimentId,
        });
      }
    }
    await this.deps.manifestStore?.save(manifest.toJSON());
    return manifest;
  }

  /** Import an instance once (idempotently within a campaign) and cache it. */
  private async resolveSnapshot(
    loaded: LoadedInstance,
    snapshotByInstance: Map<string, string>,
    reporter: ProgressReporter,
  ): Promise<string> {
    const cached = snapshotByInstance.get(loaded.instance.instanceId);
    if (cached) {
      return cached;
    }
    const imported = await this.deps.importService.importManualDiff({
      title: loaded.instance.title,
      source: "synthetic",
      rawDiff: loaded.instance.rawDiff,
    });
    snapshotByInstance.set(loaded.instance.instanceId, imported.snapshotId);
    reporter.instanceImported(loaded.instance.instanceId, imported.snapshotId);
    return imported.snapshotId;
  }

  /**
   * Concurrency-safe variant of {@link resolveSnapshot}: import an instance
   * exactly once even when several of its entries are dispatched to worker-pool
   * slots at (nearly) the same time. Memoizes the in-flight import as a
   * `Promise<string>` keyed by instanceId — concurrent callers for the same
   * instance synchronously observe and await that same promise, so there is no
   * check-then-set window where two workers both decide to import.
   */
  private resolveSnapshotConcurrent(
    loaded: LoadedInstance,
    snapshotByInstance: Map<string, string>,
    snapshotPromises: Map<string, Promise<string>>,
    reporter: ProgressReporter,
  ): Promise<string> {
    const instanceId = loaded.instance.instanceId;
    const cached = snapshotByInstance.get(instanceId);
    if (cached) {
      return Promise.resolve(cached);
    }
    const inFlight = snapshotPromises.get(instanceId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.deps.importService
      .importManualDiff({
        title: loaded.instance.title,
        source: "synthetic",
        rawDiff: loaded.instance.rawDiff,
      })
      .then((imported) => {
        snapshotByInstance.set(instanceId, imported.snapshotId);
        reporter.instanceImported(instanceId, imported.snapshotId);
        return imported.snapshotId;
      });
    snapshotPromises.set(instanceId, promise);
    return promise;
  }

  /** Execute one entry with the retry policy; returns the outcome or null on failure. */
  private async executeWithRetry(
    entry: ManifestEntry,
    loaded: LoadedInstance,
    snapshotId: string,
    executor: IExperimentExecutor,
    manifest: Manifest,
    reporter: ProgressReporter,
  ): Promise<ExecutionOutcome | null> {
    const key = manifestEntryKey(entry);
    let attempts = 0;

    for (;;) {
      attempts += 1;
      manifest.update(key, { status: "running", attempts });
      reporter.runStarted(key, attempts);
      try {
        const outcome = await executor.execute({
          datasetId: loaded.datasetId,
          instance: loaded.instance,
          snapshotId,
          architecture: entry.architecture,
          run: entry.run,
        });
        manifest.update(key, {
          status: "completed",
          snapshotId: outcome.snapshotId,
          experimentId: outcome.experimentId,
        });
        reporter.runCompleted(key, outcome.experimentId);
        await this.deps.manifestStore?.save(manifest.toJSON());
        return outcome;
      } catch (error) {
        const message = errorMessage(error);
        if (this.retryPolicy.shouldRetry(error, attempts)) {
          manifest.update(key, { status: "retry-scheduled", error: message });
          reporter.runRetry(key, attempts, message);
          await this.deps.manifestStore?.save(manifest.toJSON());
          // Exponential backoff so a Bedrock throttling window clears before we
          // re-attempt (immediate retries during a throttle just fail again).
          const waitMs = Math.min(30_000, this.retryBackoffMs * 2 ** (attempts - 1));
          if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
          continue;
        }
        // Terminal failure: record it, but never abort the campaign.
        manifest.update(key, { status: "failed", error: message });
        reporter.runFailed(key, message);
        await this.deps.manifestStore?.save(manifest.toJSON());
        return null;
      }
    }
  }

  /**
   * For entries completed in a prior run (resume), rebuild their outcome from
   * stored artifacts — reusing Storage + Evaluation + Ground Truth, without
   * re-running the experiment. Silently skips entries whose storage is gone.
   */
  private async reconstructCompletedOutcomes(
    manifest: Manifest,
    instancesById: Map<string, LoadedInstance>,
    outcomes: ExecutionOutcome[],
  ): Promise<void> {
    const present = new Set(
      outcomes.map((o) => manifestEntryKey({
        instanceId: o.instanceId,
        architecture: o.architecture,
        run: o.run,
      })),
    );
    const groundTruthEvaluator =
      this.deps.groundTruthEvaluator ?? new GroundTruthEvaluator();

    for (const entry of manifest.entries()) {
      const key = manifestEntryKey(entry);
      if (entry.status !== "completed" || present.has(key) || !entry.experimentId) {
        continue;
      }
      const loaded = instancesById.get(entry.instanceId);
      const stored = await this.deps.storage.getExperimentResult(entry.experimentId);
      if (!loaded || !stored || !stored.validatedResult || !entry.snapshotId) {
        continue;
      }
      const benchmarkRun = {
        runId: key,
        datasetId: entry.datasetId,
        instanceId: entry.instanceId,
        snapshotId: entry.snapshotId,
        experimentId: entry.experimentId,
        architecture: entry.architecture,
        producedFindings: stored.validatedResult.findings,
        groundTruth: loaded.instance.groundTruth,
      };
      outcomes.push({
        datasetId: entry.datasetId,
        instanceId: entry.instanceId,
        architecture: entry.architecture,
        run: entry.run,
        snapshotId: entry.snapshotId,
        experimentId: entry.experimentId,
        stored,
        benchmarkRun,
        benchmarkResult: groundTruthEvaluator.evaluate(benchmarkRun),
        metrics: this.evaluationEngine.evaluate(stored),
      });
    }
  }

  /** Build campaign-level CSV/JSON, reusing RFC-13 and RFC-10 exporters. */
  private async buildExports(
    manifest: Manifest,
    summary: CampaignSummary,
    outcomes: ExecutionOutcome[],
    config: CampaignConfig,
  ): Promise<CampaignExports> {
    const results = outcomes.map((o) => o.benchmarkResult);
    const benchmarkCsv = this.benchmarkExporter.export(
      results,
      config.generatedAt,
    ).content;

    const comparisons = this.evaluationEngine.evaluateBatch(
      outcomes.map((o) => o.stored),
    );
    const comparisonsCsv = (
      await this.exportService.exportComparisons(
        { generatedAt: config.generatedAt, comparisons },
        "csv",
      )
    ).content;
    const comparisonsJson = (
      await this.exportService.exportComparisons(
        { generatedAt: config.generatedAt, comparisons },
        "json",
      )
    ).content;

    const campaignJson = JSON.stringify(
      {
        manifest: manifest.toJSON(),
        summary,
        runs: outcomes.map((o) => ({
          datasetId: o.datasetId,
          instanceId: o.instanceId,
          architecture: o.architecture,
          run: o.run,
          experimentId: o.experimentId,
          snapshotId: o.snapshotId,
          benchmarkResult: o.benchmarkResult,
          metrics: o.metrics,
        })),
      },
      null,
      2,
    );

    return { benchmarkCsv, comparisonsCsv, comparisonsJson, campaignJson };
  }

  private buildExecutor(config: CampaignConfig): ExperimentExecutor {
    return new ExperimentExecutor({
      experimentService: this.deps.experimentService,
      storage: this.deps.storage,
      evaluationEngine: this.evaluationEngine,
      groundTruthEvaluator:
        this.deps.groundTruthEvaluator ?? new GroundTruthEvaluator(),
      versions: {
        modelVersion: config.modelVersion,
        promptVersion: config.promptVersion,
        workflowVersion: config.workflowVersion,
        evaluationVersion: config.evaluationVersion,
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
