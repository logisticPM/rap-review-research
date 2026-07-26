import { test } from "node:test";
import assert from "node:assert/strict";
import { SemanticCoverageEvaluator } from "../../src/benchmark/semantic-coverage-evaluator.ts";
import { CoverageScoreCache } from "../../src/benchmark/matching/coverage-score-cache.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";

function finding(id: string, title: string): ReviewFinding {
  return { id, title, category: "security", severity: "high", file: "a.ts", line: 1, description: title, recommendation: "fix", confidence: 0.9 };
}
const comments: GoldenComment[] = [
  { id: "c0", body: "sql injection", severity: "high" },
  { id: "c1", body: "missing null check", severity: "low" },
];

test("coverage, precision, f1, and by-severity from a populated cache", () => {
  const f1 = finding("f1", "SQL injection");
  const f2 = finding("f2", "noise finding"); // matches nothing
  const cache = new CoverageScoreCache();
  cache.set(f1, comments[0], 1); // f1 covers the high-severity comment
  const result = new SemanticCoverageEvaluator().evaluate([f1, f2], comments, cache);
  assert.equal(result.commentCount, 2);
  assert.equal(result.uniqueFindingCount, 2);
  assert.equal(result.matchedComments, 1);   // only c0 covered
  assert.equal(result.matchedFindings, 1);   // only f1 matched
  assert.equal(result.coverage, 0.5);        // 1/2
  assert.equal(result.precision, 0.5);       // 1/2
  assert.equal(result.coverageBySeverity.high, 1);  // 1/1 high covered
  assert.equal(result.coverageBySeverity.low, 0);   // 0/1 low covered
});

test("duplicate findings are collapsed before scoring precision", () => {
  const f1 = finding("f1", "SQL injection");
  const f1dup = finding("f1b", "SQL injection"); // A4 duplicate of f1
  const cache = new CoverageScoreCache();
  cache.set(f1, comments[0], 1);
  const result = new SemanticCoverageEvaluator().evaluate([f1, f1dup], comments, cache);
  assert.equal(result.uniqueFindingCount, 1); // collapsed
  assert.equal(result.precision, 1);          // 1 matched / 1 unique
});

test("zero denominators yield zero, not NaN", () => {
  const result = new SemanticCoverageEvaluator().evaluate([], [], new CoverageScoreCache());
  assert.equal(result.coverage, 0);
  assert.equal(result.precision, 0);
  assert.equal(result.f1, 0);
});
