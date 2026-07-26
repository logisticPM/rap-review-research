import type { ReviewArchitecture } from "../../models/experiment.ts";
import type {
  ReviewExecutionInput,
  RawReviewResult,
} from "../../models/review-result.ts";
import type { ReviewFinding, RiskLevel } from "../../models/finding.ts";
import type { IReviewArchitecture } from "../review-architecture.ts";
import type { Clock } from "../../shared/clock.ts";
import type { Logger } from "../../shared/logger.ts";
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { PromptBuilder } from "../../llm/prompts/prompt-builder.ts";
import type { RawDiffStorage } from "../../storage/raw-diff-storage.ts";
import type { ReviewArtifactRecorder } from "../../storage/review-artifact-recorder.ts";
import type { LLMConfig } from "../../config/llm.ts";
import type { IReviewSpecialist } from "./specialists/review-specialist.ts";
import type { IReviewPlanner } from "./review-plan.ts";
import type { HierarchicalReviewResult } from "./models/hierarchical-review-result.ts";
import type { HierarchicalMetrics } from "./models/hierarchical-metrics.ts";

import { SystemClock } from "../../shared/clock.ts";
import { NoopLogger } from "../../shared/logger.ts";
import { ManagerAgent } from "./manager-agent.ts";
import { DefaultReviewPlanner } from "./review-plan.ts";
import { Synthesizer } from "./synthesizer.ts";
import { BackendReviewer } from "./specialists/backend-reviewer.ts";
import { FrontendReviewer } from "./specialists/frontend-reviewer.ts";
import { DatabaseReviewer } from "./specialists/database-reviewer.ts";

export interface HierarchicalArchitectureDependencies {
  readonly specialists: IReviewSpecialist[];
  readonly planner?: IReviewPlanner;
  readonly synthesizer?: Synthesizer;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** When set, the full intermediate result is persisted for replay (B1). */
  readonly artifactRecorder?: ReviewArtifactRecorder;
}

/**
 * The Hierarchical Authority review architecture (RFC-08).
 *
 * A per-run Manager Agent coordinates registered specialist plugins and
 * synthesizes their findings into a single `RawReviewResult`. Implements
 * `IReviewArchitecture`, so it plugs into the Experiment Engine like Agentless.
 * Depends only on `IReviewSpecialist[]` — not on concrete reviewers.
 */
export class HierarchicalArchitecture implements IReviewArchitecture {
  public readonly name: ReviewArchitecture = "hierarchical";

  private readonly specialists: IReviewSpecialist[];
  private readonly planner: IReviewPlanner;
  private readonly synthesizer: Synthesizer;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly artifactRecorder?: ReviewArtifactRecorder;

  public constructor(deps: HierarchicalArchitectureDependencies) {
    this.specialists = deps.specialists;
    this.planner =
      deps.planner ??
      new DefaultReviewPlanner(deps.specialists.map((s) => s.role));
    this.synthesizer = deps.synthesizer ?? new Synthesizer();
    this.clock = deps.clock ?? new SystemClock();
    this.logger = deps.logger ?? new NoopLogger();
    this.artifactRecorder = deps.artifactRecorder;
  }

  public async execute(
    input: ReviewExecutionInput,
  ): Promise<RawReviewResult> {
    // A fresh Manager per run keeps conversation/state per-execution.
    const manager = new ManagerAgent({
      specialists: this.specialists,
      planner: this.planner,
      synthesizer: this.synthesizer,
      clock: this.clock,
      logger: this.logger,
    });
    const { result, metrics } = await manager.run(input);
    if (this.artifactRecorder) {
      await this.artifactRecorder.recordHierarchical(input.experimentId, result);
    }
    return toRawReviewResult(result, metrics);
  }
}

/** Convert the synthesized hierarchical result into a RawReviewResult. */
function toRawReviewResult(
  result: HierarchicalReviewResult,
  metrics: HierarchicalMetrics,
): RawReviewResult {
  const sum = (pick: (r: HierarchicalReviewResult["specialistResults"][number]) => number): number =>
    result.specialistResults.reduce((acc, r) => acc + pick(r), 0);

  // Well-formed review JSON so the Validation Engine can validate it downstream.
  const rawOutput = JSON.stringify({
    summary: result.managerSummary,
    riskLevel: deriveRiskLevel(result.mergedFindings),
    findings: result.mergedFindings,
  });

  return {
    architecture: "hierarchical",
    summary: result.managerSummary,
    rawOutput,
    findings: result.mergedFindings,
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    latencyMs: sum((r) => r.latencyMs) + metrics.mergeLatencyMs,
    criticalPathLatencyMs: metrics.criticalPathLatencyMs,
    truncatedCallCount: result.specialistResults.filter((r) => r.truncated).length,
    estimatedCostUsd: sum((r) => r.estimatedCostUsd),
    messageCount: metrics.messageCount,
    llmCalls: metrics.llmCalls,
  };
}

function deriveRiskLevel(findings: ReviewFinding[]): RiskLevel {
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  let max = 0;
  for (const finding of findings) {
    max = Math.max(max, order.indexOf(finding.severity));
  }
  return order[max] ?? "low";
}

/**
 * Composition helper: a Hierarchical architecture wired with the three default
 * specialists (backend, frontend, database) sharing the given LLM provider,
 * prompt builder, and raw-diff storage.
 */
export function createHierarchicalArchitecture(deps: {
  provider: ILLMProvider;
  promptBuilder: PromptBuilder;
  rawDiffStorage: RawDiffStorage;
  config?: LLMConfig;
  clock?: Clock;
  logger?: Logger;
  artifactRecorder?: ReviewArtifactRecorder;
}): HierarchicalArchitecture {
  const specialistDeps = {
    provider: deps.provider,
    promptBuilder: deps.promptBuilder,
    rawDiffStorage: deps.rawDiffStorage,
    config: deps.config,
  };
  const specialists: IReviewSpecialist[] = [
    new BackendReviewer(specialistDeps),
    new FrontendReviewer(specialistDeps),
    new DatabaseReviewer(specialistDeps),
  ];
  return new HierarchicalArchitecture({
    specialists,
    clock: deps.clock,
    logger: deps.logger,
    artifactRecorder: deps.artifactRecorder,
  });
}
