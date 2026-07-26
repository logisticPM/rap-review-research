import type { StoredExperimentResult } from "../storage/stored-models.ts";
import type { Logger } from "../shared/logger.ts";
import type { ExperimentMetrics } from "./models/experiment-metrics.ts";
import type { ExperimentComparison } from "./models/experiment-comparison.ts";
import type { IEvidenceScorer } from "./scorers/evidence-scorer.ts";

import type {
  ArchitectureFindings,
  IndustrialVerificationContext,
} from "./industrial/index.ts";

import { NoopLogger } from "../shared/logger.ts";
import { FindingMetricsCalculator } from "./finding-metrics.ts";
import { CostMetricsCalculator } from "./cost-metrics.ts";
import { EvidenceMetricsCalculator } from "./evidence-metrics.ts";
import { ComparisonEngine } from "./comparison-engine.ts";
import { HeuristicEvidenceScorer } from "./scorers/heuristic-evidence-scorer.ts";
import { IndustrialVerification } from "./industrial/index.ts";
import { EvaluationError, MetricCalculationError } from "./evaluation-errors.ts";

/**
 * Public contract of the Research Evaluation Engine (RFC-07).
 */
export interface IEvaluationEngine {
  /** Evaluate one completed experiment into metrics. */
  evaluate(result: StoredExperimentResult): ExperimentMetrics;
  /** Evaluate many experiments and group them into architecture comparisons. */
  evaluateBatch(results: StoredExperimentResult[]): ExperimentComparison[];
  /**
   * Evaluate ONE PR's architectures and augment each with industrial
   * verification signals (RAP Portal case study). Additive: the base metrics are
   * exactly {@link evaluate}'s, with `researchEvidence` extended by any
   * computable corroboration signals. `results` must be the architectures for a
   * single PR; `context` supplies optional external evidence for that PR.
   */
  evaluateIndustrial(
    results: StoredExperimentResult[],
    context?: IndustrialVerificationContext,
  ): ExperimentMetrics[];
  /**
   * Like {@link evaluateBatch}, but groups results by PR and populates
   * cross-architecture agreement within each group (plus any per-PR external
   * evidence). Used by the comparison/export/workbench paths so agreement is
   * surfaced without external data.
   */
  evaluateBatchIndustrial(
    results: StoredExperimentResult[],
    contextBySnapshotId?: Readonly<Record<string, IndustrialVerificationContext>>,
  ): ExperimentComparison[];
}

export interface EvaluationEngineDependencies {
  /** The engine depends only on this interface for evidence scoring (RFC-07 §11). */
  readonly evidenceScorer?: IEvidenceScorer;
  readonly findingCalculator?: FindingMetricsCalculator;
  readonly costCalculator?: CostMetricsCalculator;
  readonly comparisonEngine?: ComparisonEngine;
  /** Industrial-verification facade (RAP Portal case study). Optional/additive. */
  readonly industrialVerification?: IndustrialVerification;
  readonly logger?: Logger;
}

/**
 * Orchestrates the metric calculators to turn stored experiment artifacts into
 * research metrics. It contains no calculation logic itself — each calculator
 * owns one responsibility — and is stateless and deterministic.
 *
 * It never accesses repositories or external services; it operates only on the
 * supplied {@link StoredExperimentResult} objects.
 */
export class EvaluationEngine implements IEvaluationEngine {
  private readonly findingCalculator: FindingMetricsCalculator;
  private readonly costCalculator: CostMetricsCalculator;
  private readonly evidenceCalculator: EvidenceMetricsCalculator;
  private readonly comparisonEngine: ComparisonEngine;
  private readonly industrialVerification: IndustrialVerification;
  private readonly logger: Logger;

  public constructor(deps: EvaluationEngineDependencies = {}) {
    this.findingCalculator =
      deps.findingCalculator ?? new FindingMetricsCalculator();
    this.costCalculator = deps.costCalculator ?? new CostMetricsCalculator();
    this.evidenceCalculator = new EvidenceMetricsCalculator(
      deps.evidenceScorer ?? new HeuristicEvidenceScorer(),
    );
    this.comparisonEngine = deps.comparisonEngine ?? new ComparisonEngine();
    this.industrialVerification =
      deps.industrialVerification ?? new IndustrialVerification();
    this.logger = deps.logger ?? new NoopLogger();
  }

  public evaluate(result: StoredExperimentResult): ExperimentMetrics {
    const validated = result.validatedResult;
    if (!validated) {
      // A required artifact is missing — the experiment did not complete
      // validation, so there is nothing trustworthy to evaluate.
      throw new EvaluationError(
        `Cannot evaluate experiment "${result.experimentId}": no validated result.`,
      );
    }

    const reviewQuality = this.run("reviewQuality", result, (r) =>
      this.findingCalculator.calculate(r),
    );
    const operationalCost = this.run("operationalCost", result, (r) =>
      this.costCalculator.calculate(r),
    );
    const researchEvidence = this.run("researchEvidence", result, (r) =>
      this.evidenceCalculator.calculate(r),
    );

    this.logger.info("Evaluated experiment", {
      experimentId: result.experimentId,
      architecture: validated.architecture,
    });

    return {
      experimentId: result.experimentId,
      architecture: validated.architecture,
      reviewQuality,
      operationalCost,
      researchEvidence,
    };
  }

  public evaluateBatch(
    results: StoredExperimentResult[],
  ): ExperimentComparison[] {
    const metrics = results.map((result) => this.evaluate(result));
    return this.comparisonEngine.compare(metrics);
  }

  public evaluateIndustrial(
    results: StoredExperimentResult[],
    context: IndustrialVerificationContext = {},
  ): ExperimentMetrics[] {
    const base = results.map((result) => this.evaluate(result));
    const groups = this.toArchitectureFindings(results);
    const signals = this.industrialVerification.verify(groups, context);

    return base.map((metrics) => {
      const extra = signals.get(metrics.architecture);
      if (!extra) {
        return metrics;
      }
      return {
        ...metrics,
        researchEvidence: { ...metrics.researchEvidence, ...extra },
      };
    });
  }

  public evaluateBatchIndustrial(
    results: StoredExperimentResult[],
    contextBySnapshotId: Readonly<
      Record<string, IndustrialVerificationContext>
    > = {},
  ): ExperimentComparison[] {
    // Group by PR snapshot so agreement is computed among an actual PR's
    // architectures (mirrors ComparisonEngine's snapshot grouping).
    const bySnapshot = new Map<string, StoredExperimentResult[]>();
    for (const result of results) {
      const key = snapshotIdOf(result.experimentId);
      const bucket = bySnapshot.get(key);
      if (bucket) {
        bucket.push(result);
      } else {
        bySnapshot.set(key, [result]);
      }
    }

    const metrics: ExperimentMetrics[] = [];
    for (const [key, group] of bySnapshot) {
      metrics.push(
        ...this.evaluateIndustrial(group, contextBySnapshotId[key] ?? {}),
      );
    }
    return this.comparisonEngine.compare(metrics);
  }

  /** Project stored results into per-architecture findings for verification. */
  private toArchitectureFindings(
    results: StoredExperimentResult[],
  ): ArchitectureFindings[] {
    const groups: ArchitectureFindings[] = [];
    for (const result of results) {
      const validated = result.validatedResult;
      if (validated) {
        groups.push({
          architecture: validated.architecture,
          findings: validated.findings,
        });
      }
    }
    return groups;
  }

  /** Run one calculator, surfacing failures as a metric-scoped typed error. */
  private run<T>(
    metric: string,
    result: StoredExperimentResult,
    calculate: (result: StoredExperimentResult) => T,
  ): T {
    try {
      return calculate(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MetricCalculationError(
        `Failed to compute "${metric}" for experiment "${result.experimentId}": ${message}`,
      );
    }
  }
}

/**
 * The PR snapshot id is the segment before the first `#` of the experiment id
 * (the RFC-01 idempotency key `snapshotId#architecture#…`). Mirrors
 * ComparisonEngine's grouping so both agree on what "the same PR" means.
 */
function snapshotIdOf(experimentId: string): string {
  const hash = experimentId.indexOf("#");
  return hash === -1 ? experimentId : experimentId.slice(0, hash);
}

/**
 * Composition helper: an Evaluation Engine wired with the default calculators
 * and the heuristic evidence scorer.
 */
export function createEvaluationEngine(
  deps: EvaluationEngineDependencies = {},
): EvaluationEngine {
  return new EvaluationEngine(deps);
}
