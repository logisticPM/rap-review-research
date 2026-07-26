import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { BenchmarkResult } from "../models/benchmark-result.ts";

/**
 * A flat, research-ready row for one {@link BenchmarkResult}. One row per
 * architecture per benchmark instance — keeping `instanceId` stable across
 * architectures preserves the cross-architecture comparison in the CSV.
 */
export interface BenchmarkExportRow {
  readonly datasetId: string;
  readonly instanceId: string;
  readonly snapshotId: string;
  readonly architecture: ReviewArchitecture;
  readonly groundTruthCount: number;
  readonly producedCount: number;
  readonly uniqueProducedCount: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly uniquePrecision: number;
  readonly recall: number;
  readonly f1: number;
  readonly localizationAccuracy: number;
  readonly snippetLocalizationAccuracy: number;
}

/**
 * Stable CSV column order. Frozen once the benchmark freeze begins so paper
 * scripts can rely on it; kept in lockstep with {@link BenchmarkExportRow}.
 */
export const BENCHMARK_STABLE_COLUMNS: readonly (keyof BenchmarkExportRow)[] = [
  "datasetId",
  "instanceId",
  "snapshotId",
  "architecture",
  "groundTruthCount",
  "producedCount",
  "uniqueProducedCount",
  "truePositives",
  "falsePositives",
  "falseNegatives",
  "precision",
  "uniquePrecision",
  "recall",
  "f1",
  "localizationAccuracy",
  "snippetLocalizationAccuracy",
];

/** Project benchmark results into export rows. Pure; does not mutate input. */
export function toBenchmarkExportRows(
  results: BenchmarkResult[],
): BenchmarkExportRow[] {
  return results.map((r) => ({
    datasetId: r.datasetId,
    instanceId: r.instanceId,
    snapshotId: r.snapshotId,
    architecture: r.architecture,
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
  }));
}
