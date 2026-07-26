import type { IReviewArchitecture } from "../review-architecture.ts";
import type { ReviewArchitecture } from "../../models/experiment.ts";
import type {
  ReviewExecutionInput,
  RawReviewResult,
} from "../../models/review-result.ts";
import type { ReviewFinding, RiskLevel } from "../../models/finding.ts";
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { PromptBuilder, PromptRole } from "../../llm/prompts/prompt-builder.ts";
import type { RawDiffStorage } from "../../storage/raw-diff-storage.ts";
import type { LLMConfig } from "../../config/llm.ts";
import type { SpecialistReviewResult } from "../shared/specialist-review-result.ts";

import { LLM_CONFIG } from "../../config/llm.ts";
import { isTruncatedStopReason } from "../../llm/models/llm-review-response.ts";
import { parseSpecialistReview } from "../shared/review-specialist.ts";
import { Synthesizer } from "../hierarchical/synthesizer.ts";

/** The generalist prompt is the Agentless system template (single generalist reviewer). */
const GENERALIST_ROLE: PromptRole = { category: "agentless", name: "system" };
const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_SAMPLE_TEMPERATURE = 0.7;

export interface GeneralistsArchitectureDependencies {
  readonly provider: ILLMProvider;
  readonly promptBuilder: PromptBuilder;
  readonly rawDiffStorage: RawDiffStorage;
  /** Inference parameters. `temperature` here is NOT used for sampling — see `sampleTemperature`. */
  readonly config?: LLMConfig;
  /** Number of independent generalist samples (default 3). */
  readonly sampleCount?: number;
  /**
   * Sampling temperature for the generalist calls (default 0.7). Deliberately
   * > 0: identical-prompt sampling at temperature 0 would be degenerate. This is
   * the one arm whose temperature differs from the temperature-0 default — a
   * documented threat to validity (README + spec).
   */
  readonly sampleTemperature?: number;
  readonly synthesizer?: Synthesizer;
}

/**
 * The compute-matched control arm (roadmap C1): the generalist (agentless)
 * prompt sampled `sampleCount` times at `sampleTemperature`, merged by the same
 * deterministic `Synthesizer` hierarchical uses. Sits between Agentless and
 * Hierarchical on the ladder — isolating "more compute" (vs agentless) and
 * "role specialization" (vs hierarchical) with agent count and merge held
 * constant.
 */
export class GeneralistsArchitecture implements IReviewArchitecture {
  public readonly name: ReviewArchitecture = "generalists-3";

  private readonly provider: ILLMProvider;
  private readonly promptBuilder: PromptBuilder;
  private readonly rawDiffStorage: RawDiffStorage;
  private readonly config: LLMConfig;
  private readonly sampleCount: number;
  private readonly sampleTemperature: number;
  private readonly synthesizer: Synthesizer;

  public constructor(deps: GeneralistsArchitectureDependencies) {
    this.provider = deps.provider;
    this.promptBuilder = deps.promptBuilder;
    this.rawDiffStorage = deps.rawDiffStorage;
    this.config = deps.config ?? LLM_CONFIG;
    this.sampleCount = deps.sampleCount ?? DEFAULT_SAMPLE_COUNT;
    this.sampleTemperature = deps.sampleTemperature ?? DEFAULT_SAMPLE_TEMPERATURE;
    this.synthesizer = deps.synthesizer ?? new Synthesizer();
  }

  public async execute(input: ReviewExecutionInput): Promise<RawReviewResult> {
    const rawDiff = await this.rawDiffStorage.getRawDiff(input.snapshot.rawDiffS3Key);
    const request = this.promptBuilder.build({
      promptVersion: input.promptVersion,
      role: GENERALIST_ROLE,
      snapshot: input.snapshot,
      rawDiff,
      modelId: input.modelVersion,
      temperature: this.sampleTemperature,
      maxTokens: this.config.maxTokens,
    });

    // Independent samples in parallel — no data dependency between them.
    const responses = await Promise.all(
      Array.from({ length: this.sampleCount }, () => this.provider.review(request)),
    );

    const samples: SpecialistReviewResult[] = responses.map((response, i) => {
      const parsed = parseSpecialistReview(response.text, "generalist");
      return {
        role: "generalist",
        summary: parsed.summary,
        // Suffix ids per sample so identical-role findings stay unique pre-merge.
        findings: parsed.findings.map((f) => ({ ...f, id: `${f.id}#${i + 1}` })),
        latencyMs: response.latencyMs,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        estimatedCostUsd: response.estimatedCostUsd,
        truncated: isTruncatedStopReason(response.stopReason),
      };
    });

    const merged = this.synthesizer.synthesize(samples);
    // `merged.managerSummary` is intentionally ignored: it lists specialist
    // roles (hierarchical wording). A generalists-specific summary is
    // recomputed in `toRawReviewResult`.
    return toRawReviewResult(merged.mergedFindings, merged.duplicateCount, samples);
  }
}

/** Compose a RawReviewResult from the merged findings + per-sample metrics. */
function toRawReviewResult(
  findings: ReviewFinding[],
  duplicateCount: number,
  samples: SpecialistReviewResult[],
): RawReviewResult {
  const sum = (pick: (s: SpecialistReviewResult) => number): number =>
    samples.reduce((acc, s) => acc + pick(s), 0);
  const summary =
    `Generalist self-consistency over ${samples.length} sample(s): ` +
    `${findings.length} finding(s) after removing ${duplicateCount} duplicate(s).`;
  const rawOutput = JSON.stringify({
    summary,
    riskLevel: deriveRiskLevel(findings),
    findings,
  });
  return {
    architecture: "generalists-3",
    summary,
    rawOutput,
    findings,
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    latencyMs: sum((s) => s.latencyMs),
    // One parallel round: the critical path is the slowest sample. The
    // deterministic `Synthesizer.synthesize` merge cost is intentionally not
    // timed here (considered negligible), unlike hierarchical which folds in
    // `mergeLatencyMs` — the omission is deliberate, not a copy oversight.
    criticalPathLatencyMs: samples.reduce((m, s) => Math.max(m, s.latencyMs), 0),
    truncatedCallCount: samples.filter((s) => s.truncated).length,
    estimatedCostUsd: sum((s) => s.estimatedCostUsd),
    messageCount: samples.length, // one review per sample; zero inter-agent messages
    llmCalls: samples.length,
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

/** Composition helper mirroring create{Hierarchical,Consensus}Architecture. */
export function createGeneralistsArchitecture(deps: {
  provider: ILLMProvider;
  promptBuilder: PromptBuilder;
  rawDiffStorage: RawDiffStorage;
  config?: LLMConfig;
  sampleCount?: number;
  sampleTemperature?: number;
}): GeneralistsArchitecture {
  return new GeneralistsArchitecture(deps);
}
