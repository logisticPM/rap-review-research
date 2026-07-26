import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GroundTruthIssue } from "../../src/benchmark/index.ts";
import { SemanticScoreCache } from "../../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../../src/benchmark/matching/cached-semantic-matcher.ts";

const finding: ReviewFinding = { id: "f", title: "t", category: "c", severity: "high", file: "a.ts", line: 11, description: "d", recommendation: "r", confidence: 0.8 };
const issue: GroundTruthIssue = { id: "g", file: "a.ts", lineStart: 10, lineEnd: 12 };
const other: GroundTruthIssue = { id: "g2", file: "b.ts", lineStart: 1, lineEnd: 1 };

test("reads a cached score; misses return undefined (sync, no LLM)", () => {
  const cache = new SemanticScoreCache();
  cache.set(finding, issue, 0.8);
  const m = new CachedSemanticMatcher(cache);
  assert.equal(m.score(finding, issue), 0.8);
  assert.equal(m.score(finding, other), undefined);
});
