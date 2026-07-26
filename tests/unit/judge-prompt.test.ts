import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue } from "../../src/benchmark/index.ts";
import { buildJudgePrompt, parseJudgeScore, DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";

const finding: ReviewFinding = { id: "f", title: "SQL injection", category: "security", severity: "high", file: "db.ts", line: 11, description: "unsanitized input", recommendation: "sanitize", confidence: 0.8 };
const issue: GroundTruthIssue = { id: "g", file: "db.ts", lineStart: 10, lineEnd: 12, title: "SQLi", description: "injection risk" };

test("parseJudgeScore extracts, clamps, and rejects junk", () => {
  assert.equal(parseJudgeScore('{"score": 0.8}'), 0.8);
  assert.equal(parseJudgeScore('{"score": 0}'), 0);
  assert.equal(parseJudgeScore('prefix {"score": 1.5} suffix'), 1);
  assert.equal(parseJudgeScore('{"score": -0.2}'), 0);
  assert.equal(parseJudgeScore("not json"), undefined);
  assert.equal(parseJudgeScore('{"other": 1}'), undefined);
});

test("buildJudgePrompt renders both items and applies config", () => {
  const req = buildJudgePrompt(finding, issue, { modelId: "m", temperature: 0, maxTokens: 64 });
  assert.equal(req.modelId, "m");
  assert.equal(req.temperature, 0);
  assert.equal(req.maxTokens, 64);
  assert.match(req.userPrompt, /Produced finding/);
  assert.match(req.userPrompt, /Ground-truth issue/);
  assert.match(req.userPrompt, /SQL injection/);
});

test("DEFAULT_JUDGE_CONFIG is temperature 0", () => {
  assert.equal(DEFAULT_JUDGE_CONFIG.temperature, 0);
});
