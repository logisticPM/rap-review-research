import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverageJudgePrompt, DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";

const FINDING: ReviewFinding = {
  id: "f1", title: "SQL injection", category: "security", severity: "high",
  file: "a.ts", line: 10, description: "user input concatenated", recommendation: "parameterize", confidence: 0.9,
};
const COMMENT: GoldenComment = { id: "i-gc-0", body: "SQL injection via string concat", severity: "high" };

test("renders finding + human comment, no location for the comment", () => {
  const req = buildCoverageJudgePrompt(FINDING, COMMENT, DEFAULT_JUDGE_CONFIG);
  assert.match(req.userPrompt, /SQL injection/);           // finding
  assert.match(req.userPrompt, /SQL injection via string concat/); // comment body
  assert.match(req.userPrompt, /human review comment/i);
  assert.doesNotMatch(req.userPrompt.split("human review comment")[1] ?? "", /line:/); // comment block has no line
  assert.equal(req.modelId, DEFAULT_JUDGE_CONFIG.modelId);
  assert.equal(req.maxTokens, DEFAULT_JUDGE_CONFIG.maxTokens);
});
