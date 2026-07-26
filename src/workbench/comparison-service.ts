import type { IEvaluationEngine } from "../evaluation/index.ts";
import type { IStorageEngine } from "../storage/index.ts";
import type { StoredExperimentResult } from "../storage/stored-models.ts";
import type { ExperimentComparison } from "../evaluation/models/experiment-comparison.ts";
import type { ArchitectureComparisonView } from "./models/architecture-comparison-view.ts";
import type { ExperimentReadPort } from "./ports.ts";

import { ComparisonViewBuilder } from "./builders/comparison-view-builder.ts";

export interface ComparisonServiceDependencies {
  readonly experiments: ExperimentReadPort;
  readonly storage: IStorageEngine;
  readonly evaluation: IEvaluationEngine;
  readonly builder?: ComparisonViewBuilder;
}

/**
 * Aggregates the per-architecture experiments that reviewed one snapshot into an
 * {@link ArchitectureComparisonView} (RFC-11 §6, Step 6).
 *
 * The comparison itself is produced by the Evaluation Engine (which owns all
 * metric calculation); this service only gathers the inputs and delegates the
 * presentation transform to the {@link ComparisonViewBuilder}. It never computes
 * a metric.
 */
export class ComparisonService {
  private readonly experiments: ExperimentReadPort;
  private readonly storage: IStorageEngine;
  private readonly evaluation: IEvaluationEngine;
  private readonly builder: ComparisonViewBuilder;

  public constructor(deps: ComparisonServiceDependencies) {
    this.experiments = deps.experiments;
    this.storage = deps.storage;
    this.evaluation = deps.evaluation;
    this.builder = deps.builder ?? new ComparisonViewBuilder();
  }

  public async getComparison(
    snapshotId: string,
  ): Promise<ArchitectureComparisonView> {
    const all = await this.experiments.list();
    const forSnapshot = all.filter((e) => e.snapshotId === snapshotId);

    const stored: StoredExperimentResult[] = [];
    for (const experiment of forSnapshot) {
      const result = await this.storage.getExperimentResult(
        experiment.experimentId,
      );
      // Only experiments that completed validation can be evaluated/compared.
      if (result && result.validatedResult) {
        stored.push(result);
      }
    }

    // Use the industrial-aware batch so cross-architecture agreement is
    // populated (it needs the sibling architectures, which we have here). No
    // external evidence is supplied, so human/later-fix signals stay undefined.
    const comparison = this.selectComparison(
      this.evaluation.evaluateBatchIndustrial(stored),
      snapshotId,
    );
    return this.builder.build({ snapshotId, comparison });
  }

  /**
   * The Comparison Engine keys groups by snapshot id (the segment before the
   * first `#` in the experiment id), so the matching group is the one whose
   * `experimentId` equals the snapshot id.
   */
  private selectComparison(
    comparisons: ExperimentComparison[],
    snapshotId: string,
  ): ExperimentComparison | null {
    return comparisons.find((c) => c.experimentId === snapshotId) ?? null;
  }
}
