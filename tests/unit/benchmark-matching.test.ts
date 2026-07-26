import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue, ISemanticMatcher } from "../../src/benchmark/index.ts";
import { IssueMatcher, NoopSemanticMatcher } from "../../src/benchmark/index.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f",
    title: "issue",
    category: "correctness",
    severity: "high",
    file: "src/a.ts",
    line: 11,
    description: "d",
    recommendation: "r",
    confidence: 0.8,
    ...overrides,
  };
}

function gt(overrides: Partial<GroundTruthIssue> = {}): GroundTruthIssue {
  return {
    id: "g",
    file: "src/a.ts",
    lineStart: 10,
    lineEnd: 12,
    ...overrides,
  };
}

test("matches on exact file and line-range overlap", () => {
  const m = new IssueMatcher().match(finding({ line: 11 }), gt());
  assert.equal(m.matched, true);
  assert.equal(m.fileMatch, true);
  assert.equal(m.lineOverlap, true);
});

test("file match but line outside the range does not match by default", () => {
  const m = new IssueMatcher().match(finding({ line: 50 }), gt());
  assert.equal(m.fileMatch, true);
  assert.equal(m.lineOverlap, false);
  assert.equal(m.matched, false);
});

test("different files never match", () => {
  const m = new IssueMatcher().match(finding({ file: "src/other.ts" }), gt());
  assert.equal(m.fileMatch, false);
  assert.equal(m.matched, false);
});

test("normalizes a leading ./ in paths", () => {
  const m = new IssueMatcher().match(finding({ file: "./src/a.ts" }), gt());
  assert.equal(m.fileMatch, true);
});

test("category/severity comparison is defined only when the issue provides them", () => {
  const withAttrs = new IssueMatcher().match(
    finding({ category: "Security", severity: "high" }),
    gt({ category: "security", severity: "high" }),
  );
  assert.equal(withAttrs.categoryMatch, true); // case-insensitive
  assert.equal(withAttrs.severityMatch, true);

  const withoutAttrs = new IssueMatcher().match(finding(), gt());
  assert.equal(withoutAttrs.categoryMatch, undefined);
  assert.equal(withoutAttrs.severityMatch, undefined);
});

test("requireCategoryMatch gates matching when both sides have a category", () => {
  const m = new IssueMatcher({ requireCategoryMatch: true }).match(
    finding({ category: "performance", line: 11 }),
    gt({ category: "security" }),
  );
  assert.equal(m.fileMatch, true);
  assert.equal(m.lineOverlap, true);
  assert.equal(m.categoryMatch, false);
  assert.equal(m.matched, false);
});

test("semantic matching is a no-op placeholder (no score, no LLM)", () => {
  const m = new IssueMatcher({ semanticMatcher: new NoopSemanticMatcher() }).match(
    finding(),
    gt(),
  );
  assert.equal(m.semanticScore, undefined);
});

test("a semantic score >= threshold rescues a same-file, non-overlapping match", () => {
  const stub: ISemanticMatcher = { score: () => 0.9 };
  const m = new IssueMatcher({ semanticMatcher: stub, semanticThreshold: 0.7 });
  const result = m.match(finding({ line: 50 }), gt()); // 50 not in [10,12]
  assert.equal(result.lineOverlap, false);
  assert.equal(result.semanticScore, 0.9);
  assert.equal(result.matched, true);
});

test("a semantic score below threshold does not rescue", () => {
  const stub: ISemanticMatcher = { score: () => 0.5 };
  const m = new IssueMatcher({ semanticMatcher: stub, semanticThreshold: 0.7 });
  assert.equal(m.match(finding({ line: 50 }), gt()).matched, false);
});

test("default (Noop) matcher leaves line-based matching unchanged", () => {
  const m = new IssueMatcher();
  assert.equal(m.match(finding({ line: 50 }), gt()).matched, false);
  assert.equal(m.match(finding({ line: 11 }), gt()).matched, true);
});

test("semantic rescue does not override a different-file mismatch", () => {
  const stub: ISemanticMatcher = { score: () => 1 };
  const m = new IssueMatcher({ semanticMatcher: stub });
  assert.equal(m.match(finding({ file: "other.ts", line: 11 }), gt()).matched, false);
});
