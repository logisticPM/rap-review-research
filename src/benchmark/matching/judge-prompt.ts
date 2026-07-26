import type { ReviewFinding } from "../../models/finding.ts";
import type { GroundTruthIssue } from "../models/ground-truth-issue.ts";
import type { GoldenComment } from "../models/golden-comment.ts";
import type { LLMReviewRequest } from "../../llm/models/llm-review-request.ts";

/** Model + inference config for the semantic judge (A2). */
export interface JudgeConfig {
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

/**
 * Default judge: a Bedrock non-Anthropic model (different family than the Claude
 * systems under test). Confirm the id is enabled in the target region before the
 * pilot; override via `JudgeConfig`.
 */
export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  modelId: "us.meta.llama3-3-70b-instruct-v1:0",
  temperature: 0,
  maxTokens: 64,
};

const JUDGE_SYSTEM_PROMPT =
  "You are a strict evaluator for a code-review benchmark. You are given ONE " +
  "finding produced by an automated reviewer and ONE ground-truth issue. Decide " +
  "whether they describe THE SAME underlying problem at the same code location, " +
  "allowing for reworded descriptions and small line differences. Respond with " +
  'ONLY a JSON object {"score": n} where n is in [0,1]: 1 = certainly the same ' +
  "issue, 0 = certainly different. Output no other text.";

function renderFinding(f: ReviewFinding): string {
  return `file: ${f.file}\nline: ${f.line}\ntitle: ${f.title}\ndescription: ${f.description}`;
}
function renderIssue(i: GroundTruthIssue): string {
  return `file: ${i.file}\nlines: ${i.lineStart}-${i.lineEnd}\ntitle: ${i.title ?? "(none)"}\ndescription: ${i.description ?? "(none)"}`;
}

export function buildJudgePrompt(
  finding: ReviewFinding,
  issue: GroundTruthIssue,
  config: JudgeConfig,
): LLMReviewRequest {
  return {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt: `## Produced finding\n${renderFinding(finding)}\n\n## Ground-truth issue\n${renderIssue(issue)}`,
    modelId: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

/** Tolerant parse of a judge response into a score in [0,1], or undefined. */
export function parseJudgeScore(text: string): number | undefined {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end < start) {
      return undefined;
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const score = parsed.score;
    if (typeof score !== "number" || Number.isNaN(score)) {
      return undefined;
    }
    return Math.max(0, Math.min(1, score));
  } catch {
    return undefined;
  }
}

const COVERAGE_SYSTEM_PROMPT =
  "You are a strict evaluator for a code-review benchmark. You are given ONE " +
  "finding produced by an automated reviewer and ONE human review comment. The " +
  "human comment has no line number. Decide whether they describe THE SAME " +
  "underlying issue, allowing for reworded descriptions. Respond with ONLY a " +
  'JSON object {"score": n} where n is in [0,1]: 1 = certainly the same issue, ' +
  "0 = certainly different. Output no other text.";

function renderComment(c: GoldenComment): string {
  return `severity: ${c.severity ?? "(none)"}\ncomment: ${c.body}`;
}

/**
 * Judge prompt for SWE coverage: is the produced finding the same underlying
 * issue as this (location-less) human review comment? Reuses {@link parseJudgeScore}.
 */
export function buildCoverageJudgePrompt(
  finding: ReviewFinding,
  comment: GoldenComment,
  config: JudgeConfig,
): LLMReviewRequest {
  return {
    systemPrompt: COVERAGE_SYSTEM_PROMPT,
    userPrompt: `## Produced finding\n${renderFinding(finding)}\n\n## Human review comment\n${renderComment(comment)}`,
    modelId: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}
