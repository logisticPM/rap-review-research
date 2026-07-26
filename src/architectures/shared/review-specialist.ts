import type { AgentRole } from "./agent.ts";
import type { ReviewExecutionInput } from "../../models/review-result.ts";
import type { ReviewFinding, SeverityLevel } from "../../models/finding.ts";
import type { SpecialistReviewResult } from "./specialist-review-result.ts";
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { PromptBuilder } from "../../llm/prompts/prompt-builder.ts";
import type { RawDiffStorage } from "../../storage/raw-diff-storage.ts";
import type { LLMConfig } from "../../config/llm.ts";

import { LLM_CONFIG } from "../../config/llm.ts";
import { isTruncatedStopReason } from "../../llm/models/llm-review-response.ts";

/**
 * The specialist plugin contract, shared by Hierarchical and Consensus.
 * Coordinators/managers depend only on this — never on concrete reviewers — so
 * new specialists can be added without changing them. Mirrors
 * `IReviewArchitecture` / `ILLMProvider` / `IEvidenceScorer`.
 */
export interface IReviewSpecialist {
  readonly role: AgentRole;
  review(input: ReviewExecutionInput): Promise<SpecialistReviewResult>;
}

export interface ReviewSpecialistDependencies {
  readonly provider: ILLMProvider;
  readonly promptBuilder: PromptBuilder;
  readonly rawDiffStorage: RawDiffStorage;
  readonly config?: LLMConfig;
}

export interface SpecialistConfig {
  readonly role: AgentRole;
  /** Prompt template category, e.g. "hierarchical" or "consensus". */
  readonly promptCategory: string;
  /** Role template name under the category. Defaults to the role. */
  readonly templateName?: string;
}

/**
 * The JSON output contract every specialist review/revision round must follow,
 * mirroring the exact shape {@link toReviewFinding} requires. It is passed to
 * the {@link PromptBuilder} (rendered into the user prompt) so the model returns
 * parseable findings instead of a Markdown review.
 *
 * Without it the specialist role templates only *reference* "the JSON shape
 * described in the system instructions" — a shape that is never actually shown —
 * so the model emits prose and {@link parseSpecialistReview} silently drops
 * every finding, leaving Hierarchical and Consensus with 0 findings. Agentless
 * is unaffected because its own template embeds this shape inline.
 */
export const SPECIALIST_FINDINGS_SCHEMA = {
  summary: "one-paragraph overall assessment",
  findings: [
    {
      title: "short title",
      severity: "low | medium | high | critical",
      category: "correctness | security | performance | maintainability | ...",
      file: "path/to/file",
      line: 0,
      description: "what the problem is",
      recommendation: "how to fix it",
      confidence: 0.0,
    },
  ],
};

/**
 * Shared base for LLM-backed specialists.
 *
 * Independently builds a role-specific prompt (common instructions +
 * `<promptCategory>/<templateName>` template) via the shared PromptBuilder,
 * makes exactly one `ILLMProvider` call, and surfaces its findings. Never calls
 * Bedrock directly; never touches domain repositories (only the RawDiffStorage
 * port).
 */
export class LlmReviewSpecialist implements IReviewSpecialist {
  public readonly role: AgentRole;
  protected readonly promptCategory: string;
  protected readonly templateName: string;
  protected readonly provider: ILLMProvider;
  protected readonly promptBuilder: PromptBuilder;
  protected readonly rawDiffStorage: RawDiffStorage;
  protected readonly config: LLMConfig;

  public constructor(
    config: SpecialistConfig,
    deps: ReviewSpecialistDependencies,
  ) {
    this.role = config.role;
    this.promptCategory = config.promptCategory;
    this.templateName = config.templateName ?? config.role;
    this.provider = deps.provider;
    this.promptBuilder = deps.promptBuilder;
    this.rawDiffStorage = deps.rawDiffStorage;
    this.config = deps.config ?? LLM_CONFIG;
  }

  public async review(
    input: ReviewExecutionInput,
  ): Promise<SpecialistReviewResult> {
    const rawDiff = await this.rawDiffStorage.getRawDiff(
      input.snapshot.rawDiffS3Key,
    );
    const request = this.promptBuilder.build({
      promptVersion: input.promptVersion,
      role: { category: this.promptCategory, name: this.templateName },
      snapshot: input.snapshot,
      rawDiff,
      modelId: input.modelVersion,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      jsonSchema: SPECIALIST_FINDINGS_SCHEMA,
    });
    const response = await this.provider.review(request);
    const parsed = parseSpecialistReview(response.text, this.role);
    return {
      role: this.role,
      summary: parsed.summary,
      findings: parsed.findings,
      latencyMs: response.latencyMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estimatedCostUsd: response.estimatedCostUsd,
      truncated: isTruncatedStopReason(response.stopReason),
    };
  }
}

const SEVERITIES: readonly SeverityLevel[] = ["low", "medium", "high", "critical"];

/**
 * Tolerant, best-effort surfacing of a specialist's JSON output into typed
 * findings. NOT validation: never throws, never invents data — findings missing
 * required fields are skipped. Authoritative schema validation happens
 * downstream on the merged RawReviewResult (RFC-05).
 */
export function parseSpecialistReview(
  text: string,
  role: AgentRole,
): { summary: string; findings: ReviewFinding[] } {
  try {
    const cleaned = text.replace(/```[a-zA-Z0-9]*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end < start) {
      return { summary: "", findings: [] };
    }
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

    const findings: ReviewFinding[] = [];
    rawFindings.forEach((raw, index) => {
      const finding = toReviewFinding(raw, role, index);
      if (finding) {
        findings.push(finding);
      }
    });
    return { summary, findings };
  } catch {
    return { summary: "", findings: [] };
  }
}

/** Map a raw finding object to a ReviewFinding, or null if it is incomplete. */
export function toReviewFinding(
  raw: unknown,
  role: AgentRole,
  index: number,
): ReviewFinding | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const f = raw as Record<string, unknown>;
  const severity =
    typeof f.severity === "string" ? f.severity.toLowerCase() : "";
  if (!SEVERITIES.includes(severity as SeverityLevel)) {
    return null;
  }
  if (
    typeof f.title !== "string" ||
    typeof f.category !== "string" ||
    typeof f.file !== "string" ||
    typeof f.line !== "number" ||
    typeof f.description !== "string" ||
    typeof f.recommendation !== "string" ||
    typeof f.confidence !== "number"
  ) {
    return null;
  }
  return {
    id: `${role}-${index + 1}`,
    title: f.title,
    severity: severity as SeverityLevel,
    category: f.category.toLowerCase(),
    file: f.file,
    line: f.line,
    ...(typeof f.snippet === "string" ? { snippet: f.snippet } : {}),
    description: f.description,
    recommendation: f.recommendation,
    confidence: Math.max(0, Math.min(1, f.confidence)),
  };
}
