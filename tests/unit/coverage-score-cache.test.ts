import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageScoreCache, coveragePairKey } from "../../src/benchmark/matching/coverage-score-cache.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";

const FINDING: ReviewFinding = {
  id: "f1", title: "SQL injection", category: "security", severity: "high",
  file: "a.ts", line: 10, description: "user input concatenated", recommendation: "parameterize", confidence: 0.9,
};
const COMMENT: GoldenComment = { id: "i-gc-0", body: "SQL injection via string concat", severity: "high" };

test("set/get/has round-trip and JSON persistence", () => {
  const cache = new CoverageScoreCache();
  assert.equal(cache.has(FINDING, COMMENT), false);
  cache.set(FINDING, COMMENT, 1);
  assert.equal(cache.get(FINDING, COMMENT), 1);
  const revived = CoverageScoreCache.fromJSON(cache.toJSON());
  assert.equal(revived.get(FINDING, COMMENT), 1);
});

test("pairKey ignores finding.line (A3 re-anchor seam)", () => {
  assert.equal(
    coveragePairKey({ ...FINDING, line: 10 }, COMMENT),
    coveragePairKey({ ...FINDING, line: 999 }, COMMENT),
  );
});
