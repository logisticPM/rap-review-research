import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue } from "../../src/benchmark/index.ts";
import { SemanticScoreCache, pairKey } from "../../src/benchmark/matching/semantic-score-cache.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { id: "f", title: "t", category: "correctness", severity: "high", file: "a.ts", line: 11, description: "d", recommendation: "r", confidence: 0.8, ...overrides };
}
function issue(overrides: Partial<GroundTruthIssue> = {}): GroundTruthIssue {
  return { id: "g", file: "a.ts", lineStart: 10, lineEnd: 12, ...overrides };
}

test("get returns undefined before set, the score after", () => {
  const c = new SemanticScoreCache();
  assert.equal(c.get(finding(), issue()), undefined);
  assert.equal(c.has(finding(), issue()), false);
  c.set(finding(), issue(), 0.9);
  assert.equal(c.get(finding(), issue()), 0.9);
  assert.equal(c.has(finding(), issue()), true);
});

test("different pairs get different keys", () => {
  assert.notEqual(pairKey(finding({ title: "A" }), issue()), pairKey(finding({ title: "B" }), issue()));
});

test("changing only the finding line does NOT change the key (A2/A3 seam)", () => {
  assert.equal(pairKey(finding({ line: 10 }), issue()), pairKey(finding({ line: 999 }), issue()));
  const c = new SemanticScoreCache();
  c.set(finding({ line: 10 }), issue(), 0.9);
  assert.equal(c.get(finding({ line: 999 }), issue()), 0.9); // re-anchored finding still hits
});

test("toJSON/fromJSON round-trips", () => {
  const c = new SemanticScoreCache();
  c.set(finding(), issue(), 0.5);
  const restored = SemanticScoreCache.fromJSON(c.toJSON());
  assert.equal(restored.get(finding(), issue()), 0.5);
});
