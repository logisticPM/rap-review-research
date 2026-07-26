import type {
  BenchmarkResult,
  BenchmarkArchitectureSummary,
} from "../benchmark/index.ts";
import type { Manifest, ManifestProgress } from "./manifest.ts";
import type { ExecutionOutcome } from "./experiment-executor.ts";

import { BenchmarkEvaluator } from "../benchmark/index.ts";

/** Per-dataset coverage counts. */
export interface DatasetCoverage {
  readonly datasetId: string;
  readonly instanceCount: number;
  readonly completedRuns: number;
}

/** A failed run, preserved for the audit trail (runbook 03 §16). */
export interface CampaignFailure {
  readonly instanceId: string;
  readonly architecture: string;
  readonly run: number;
  readonly attempts: number;
  readonly error: string;
}

/**
 * Per-architecture output-truncation rate (B2). `truncatedRuns` counts runs
 * with at least one call cut off by the token cap; a high rate flags that
 * recall gaps may be a token-budget artifact rather than a topology effect.
 */
export interface ArchitectureTruncation {
  readonly architecture: string;
  readonly runs: number;
  readonly truncatedRuns: number;
  readonly totalTruncatedCalls: number;
  readonly truncationRate: number;
}

/**
 * A reproducible, campaign-level rollup. It reports counts, per-architecture
 * macro metrics (reusing the RFC-13 {@link BenchmarkEvaluator} — no new metric
 * is defined here), dataset coverage, and the failure audit trail.
 */
export interface CampaignSummary {
  readonly campaignId: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly progress: ManifestProgress;
  readonly perArchitecture: BenchmarkArchitectureSummary[];
  readonly truncation: ArchitectureTruncation[];
  readonly datasets: DatasetCoverage[];
  readonly failures: CampaignFailure[];
}

export interface BuildCampaignSummaryInput {
  readonly manifest: Manifest;
  readonly outcomes: ExecutionOutcome[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly benchmarkEvaluator?: BenchmarkEvaluator;
}

/**
 * Build the campaign summary from the manifest and the successful outcomes.
 * Pure and deterministic; delegates all metric aggregation to the existing
 * Benchmark Evaluator.
 */
export function buildCampaignSummary(
  input: BuildCampaignSummaryInput,
): CampaignSummary {
  const { manifest, outcomes, startedAt, finishedAt } = input;
  const evaluator = input.benchmarkEvaluator ?? new BenchmarkEvaluator();

  const results: BenchmarkResult[] = outcomes.map((o) => o.benchmarkResult);
  const perArchitecture = evaluator.summarizeByArchitecture(results);
  const truncation = buildTruncation(outcomes);

  const datasets = buildDatasetCoverage(outcomes);
  const failures: CampaignFailure[] = manifest
    .entries()
    .filter((e) => e.status === "failed")
    .map((e) => ({
      instanceId: e.instanceId,
      architecture: e.architecture,
      run: e.run,
      attempts: e.attempts,
      error: e.error ?? "unknown error",
    }));

  return {
    campaignId: manifest.campaignId,
    startedAt,
    finishedAt,
    progress: manifest.progress(),
    perArchitecture,
    truncation,
    datasets,
    failures,
  };
}

/** Group runs by architecture and compute their output-truncation rates (B2). */
function buildTruncation(outcomes: ExecutionOutcome[]): ArchitectureTruncation[] {
  const byArchitecture = new Map<
    string,
    { runs: number; truncatedRuns: number; totalTruncatedCalls: number }
  >();
  for (const outcome of outcomes) {
    // Defensive: operational metrics are always present on real outcomes, but
    // tolerate partial data rather than crash the whole summary.
    const calls = outcome.metrics.operationalCost?.truncatedCallCount ?? 0;
    const architecture = outcome.metrics.architecture ?? outcome.benchmarkResult.architecture;
    const bucket = byArchitecture.get(architecture) ?? {
      runs: 0,
      truncatedRuns: 0,
      totalTruncatedCalls: 0,
    };
    bucket.runs += 1;
    bucket.totalTruncatedCalls += calls;
    if (calls > 0) {
      bucket.truncatedRuns += 1;
    }
    byArchitecture.set(architecture, bucket);
  }
  return [...byArchitecture.keys()].sort().map((architecture) => {
    const b = byArchitecture.get(architecture) as {
      runs: number;
      truncatedRuns: number;
      totalTruncatedCalls: number;
    };
    return {
      architecture,
      runs: b.runs,
      truncatedRuns: b.truncatedRuns,
      totalTruncatedCalls: b.totalTruncatedCalls,
      truncationRate: b.runs === 0 ? 0 : b.truncatedRuns / b.runs,
    };
  });
}

function buildDatasetCoverage(outcomes: ExecutionOutcome[]): DatasetCoverage[] {
  const byDataset = new Map<string, { instances: Set<string>; runs: number }>();
  for (const outcome of outcomes) {
    const bucket = byDataset.get(outcome.datasetId) ?? {
      instances: new Set<string>(),
      runs: 0,
    };
    bucket.instances.add(outcome.instanceId);
    bucket.runs += 1;
    byDataset.set(outcome.datasetId, bucket);
  }
  return [...byDataset.keys()].sort().map((datasetId) => {
    const bucket = byDataset.get(datasetId) as {
      instances: Set<string>;
      runs: number;
    };
    return {
      datasetId,
      instanceCount: bucket.instances.size,
      completedRuns: bucket.runs,
    };
  });
}
