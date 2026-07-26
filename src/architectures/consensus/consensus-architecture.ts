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
import type { IConsensusSpecialist } from "./consensus-specialist.ts";
import type { IConsensusProtocol } from "./protocols/consensus-protocol.ts";
import type { ConsensusReviewResult } from "./models/consensus-review-result.ts";

import { SystemClock } from "../../shared/clock.ts";
import { NoopLogger } from "../../shared/logger.ts";
import { ConsensusCoordinator } from "./consensus-coordinator.ts";
import { ConsensusSynthesizer } from "./consensus-synthesizer.ts";
import { ConsensusSpecialist } from "./consensus-specialist.ts";
import { MajorityVoteConsensusProtocol } from "./protocols/majority-vote-protocol.ts";

export interface ConsensusArchitectureDependencies {
  readonly specialists: IConsensusSpecialist[];
  readonly protocol?: IConsensusProtocol;
  readonly synthesizer?: ConsensusSynthesizer;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** When set, the full intermediate result is persisted for replay (B1). */
  readonly artifactRecorder?: ReviewArtifactRecorder;
}

/**
 * The Decentralized Consensus review architecture (RFC-09).
 *
 * A per-run ConsensusCoordinator drives a pluggable IConsensusProtocol over
 * peer specialists (independent review → exchange → revision → voting →
 * majority-rule synthesis), then converts the accepted findings into a
 * RawReviewResult. Implements IReviewArchitecture (`name = "consensus"`).
 */
export class ConsensusArchitecture implements IReviewArchitecture {
  public readonly name: ReviewArchitecture = "consensus";

  private readonly specialists: IConsensusSpecialist[];
  private readonly protocol: IConsensusProtocol;
  private readonly synthesizer: ConsensusSynthesizer;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly artifactRecorder?: ReviewArtifactRecorder;

  public constructor(deps: ConsensusArchitectureDependencies) {
    this.specialists = deps.specialists;
    this.protocol = deps.protocol ?? new MajorityVoteConsensusProtocol();
    this.synthesizer = deps.synthesizer ?? new ConsensusSynthesizer();
    this.clock = deps.clock ?? new SystemClock();
    this.logger = deps.logger ?? new NoopLogger();
    this.artifactRecorder = deps.artifactRecorder;
  }

  public async execute(
    input: ReviewExecutionInput,
  ): Promise<RawReviewResult> {
    const coordinator = new ConsensusCoordinator({
      specialists: this.specialists,
      synthesizer: this.synthesizer,
      protocol: this.protocol,
      clock: this.clock,
      logger: this.logger,
    });
    const { result } = await coordinator.run(input);
    if (this.artifactRecorder) {
      await this.artifactRecorder.recordConsensus(input.experimentId, result);
    }
    return toRawReviewResult(result);
  }
}

/** Convert the consensus result into a RawReviewResult (accepted findings only). */
function toRawReviewResult(result: ConsensusReviewResult): RawReviewResult {
  const metrics = result.consensusMetrics;
  const rawOutput = JSON.stringify({
    summary: result.summary,
    riskLevel: deriveRiskLevel(result.acceptedFindings),
    findings: result.acceptedFindings,
  });
  return {
    architecture: "consensus",
    summary: result.summary,
    rawOutput,
    findings: result.acceptedFindings,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    latencyMs: metrics.latencyMs,
    criticalPathLatencyMs: metrics.criticalPathLatencyMs,
    truncatedCallCount: metrics.truncatedCallCount,
    estimatedCostUsd: metrics.estimatedCostUsd,
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
 * Composition helper: a Consensus architecture wired with the three default
 * peer specialists (backend, frontend, database) sharing the given LLM provider,
 * prompt builder, and raw-diff storage, using the majority-vote protocol.
 */
export function createConsensusArchitecture(deps: {
  provider: ILLMProvider;
  promptBuilder: PromptBuilder;
  rawDiffStorage: RawDiffStorage;
  config?: LLMConfig;
  clock?: Clock;
  logger?: Logger;
  protocol?: IConsensusProtocol;
  artifactRecorder?: ReviewArtifactRecorder;
}): ConsensusArchitecture {
  const specialistDeps = {
    provider: deps.provider,
    promptBuilder: deps.promptBuilder,
    rawDiffStorage: deps.rawDiffStorage,
    config: deps.config,
  };
  const specialists: IConsensusSpecialist[] = [
    new ConsensusSpecialist("backend", specialistDeps),
    new ConsensusSpecialist("frontend", specialistDeps),
    new ConsensusSpecialist("database", specialistDeps),
  ];
  return new ConsensusArchitecture({
    specialists,
    protocol: deps.protocol,
    clock: deps.clock,
    logger: deps.logger,
    artifactRecorder: deps.artifactRecorder,
  });
}
