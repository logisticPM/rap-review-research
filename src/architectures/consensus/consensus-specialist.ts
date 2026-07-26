import type { AgentRole } from "../shared/agent.ts";
import type {
  IReviewSpecialist,
  ReviewSpecialistDependencies,
} from "../shared/review-specialist.ts";
import type { SpecialistReviewResult } from "../shared/specialist-review-result.ts";
import type { ReviewExecutionInput } from "../../models/review-result.ts";
import type { ReviewFinding } from "../../models/finding.ts";
import type { LLMConfig } from "../../config/llm.ts";
import type { ILLMProvider } from "../../llm/provider/llm-provider.ts";
import type { PromptBuilder } from "../../llm/prompts/prompt-builder.ts";
import type { RawDiffStorage } from "../../storage/raw-diff-storage.ts";
import type { CandidateFinding } from "./models/candidate-finding.ts";
import type { ReviewVote, ConsensusVoteValue } from "./models/review-vote.ts";

import { LLM_CONFIG } from "../../config/llm.ts";
import {
  LlmReviewSpecialist,
  parseSpecialistReview,
  SPECIALIST_FINDINGS_SCHEMA,
} from "../shared/review-specialist.ts";
import { isTruncatedStopReason } from "../../llm/models/llm-review-response.ts";

const VOTE_VALUES: readonly ConsensusVoteValue[] = ["accept", "reject", "revise"];

/**
 * A consensus specialist: a shared `IReviewSpecialist` (independent review round)
 * extended with peer-aware `revise` and `vote` rounds. Each round is one
 * `ILLMProvider` call built via the shared `PromptBuilder` (consensus templates).
 * Never calls Bedrock directly.
 */
/** A specialist's voting-round output plus that call's LLM usage. */
export interface SpecialistVoteResult {
  readonly votes: ReviewVote[];
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** This voting call was cut off by the output-token cap (B2). */
  readonly truncated?: boolean;
}

export interface IConsensusSpecialist extends IReviewSpecialist {
  /** Round 3: revise own findings given all peers' Round-1 findings. */
  revise(
    input: ReviewExecutionInput,
    peerFindings: ReviewFinding[],
  ): Promise<SpecialistReviewResult>;
  /** Round 4: vote on each candidate finding. */
  vote(
    input: ReviewExecutionInput,
    candidates: CandidateFinding[],
  ): Promise<SpecialistVoteResult>;
}

export class ConsensusSpecialist implements IConsensusSpecialist {
  public readonly role: AgentRole;
  private readonly reviewDelegate: LlmReviewSpecialist;
  private readonly provider: ILLMProvider;
  private readonly promptBuilder: PromptBuilder;
  private readonly rawDiffStorage: RawDiffStorage;
  private readonly config: LLMConfig;

  public constructor(role: AgentRole, deps: ReviewSpecialistDependencies) {
    this.role = role;
    this.reviewDelegate = new LlmReviewSpecialist(
      { role, promptCategory: "consensus", templateName: `${role}-review` },
      deps,
    );
    this.provider = deps.provider;
    this.promptBuilder = deps.promptBuilder;
    this.rawDiffStorage = deps.rawDiffStorage;
    this.config = deps.config ?? LLM_CONFIG;
  }

  public review(input: ReviewExecutionInput): Promise<SpecialistReviewResult> {
    return this.reviewDelegate.review(input);
  }

  public async revise(
    input: ReviewExecutionInput,
    peerFindings: ReviewFinding[],
  ): Promise<SpecialistReviewResult> {
    const response = await this.callRound(
      input,
      "revision",
      renderFindings(peerFindings),
      SPECIALIST_FINDINGS_SCHEMA,
    );
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

  public async vote(
    input: ReviewExecutionInput,
    candidates: CandidateFinding[],
  ): Promise<SpecialistVoteResult> {
    const response = await this.callRound(input, "voting", renderCandidates(candidates));
    const validIds = new Set(candidates.map((c) => c.candidateId));
    return {
      votes: parseVotes(response.text, this.role, validIds),
      latencyMs: response.latencyMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estimatedCostUsd: response.estimatedCostUsd,
      truncated: isTruncatedStopReason(response.stopReason),
    };
  }

  /**
   * One consensus-round LLM call with round-specific context appended. Rounds
   * whose output is parsed as findings (revision) pass the findings schema so
   * the model returns JSON; the voting round omits it because its template
   * already embeds its own `{ votes: [...] }` shape.
   */
  private async callRound(
    input: ReviewExecutionInput,
    templateName: string,
    additionalContext: string,
    jsonSchema?: object,
  ) {
    const rawDiff = await this.rawDiffStorage.getRawDiff(
      input.snapshot.rawDiffS3Key,
    );
    const request = this.promptBuilder.build({
      promptVersion: input.promptVersion,
      role: { category: "consensus", name: templateName },
      snapshot: input.snapshot,
      rawDiff,
      modelId: input.modelVersion,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      additionalContext,
      jsonSchema,
    });
    return this.provider.review(request);
  }
}

function renderFindings(findings: ReviewFinding[]): string {
  const lines = findings.map(
    (f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.title} (${f.id})`,
  );
  return `## Peer findings\n\n${lines.join("\n")}`;
}

function renderCandidates(candidates: CandidateFinding[]): string {
  const lines = candidates.map(
    (c) => `- ${c.candidateId}: [${c.severity}] ${c.file}:${c.line} — ${c.title}`,
  );
  return `## Candidate findings to vote on\n\n${lines.join("\n")}`;
}

/** Tolerant parse of a voting response into ReviewVotes. Never throws/invents. */
function parseVotes(
  text: string,
  reviewer: AgentRole,
  validCandidateIds: Set<string>,
): ReviewVote[] {
  try {
    const cleaned = text.replace(/```[a-zA-Z0-9]*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end < start) {
      return [];
    }
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    const rawVotes = Array.isArray(parsed.votes) ? parsed.votes : [];
    const votes: ReviewVote[] = [];
    for (const raw of rawVotes) {
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const v = raw as Record<string, unknown>;
      const findingId = typeof v.candidateId === "string" ? v.candidateId : "";
      const value = typeof v.vote === "string" ? v.vote.toLowerCase() : "";
      if (!validCandidateIds.has(findingId)) {
        continue;
      }
      if (!VOTE_VALUES.includes(value as ConsensusVoteValue)) {
        continue;
      }
      votes.push({
        findingId,
        reviewer,
        vote: value as ConsensusVoteValue,
        reason: typeof v.reason === "string" ? v.reason : "",
        confidence:
          typeof v.confidence === "number"
            ? Math.max(0, Math.min(1, v.confidence))
            : 0,
      });
    }
    return votes;
  } catch {
    return [];
  }
}
