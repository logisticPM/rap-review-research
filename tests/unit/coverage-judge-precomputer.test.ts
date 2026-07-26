import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageJudgePrecomputer } from "../../src/benchmark/matching/coverage-judge-precomputer.ts";
import { CoverageScoreCache } from "../../src/benchmark/matching/coverage-score-cache.ts";
import { DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";
import type { BenchmarkRun } from "../../src/benchmark/models/benchmark-run.ts";
import type { GoldenComment } from "../../src/benchmark/models/golden-comment.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";

function finding(id: string, title: string): ReviewFinding {
  return { id, title, category: "security", severity: "high", file: "a.ts", line: 1, description: title, recommendation: "fix", confidence: 0.9 };
}
const run: BenchmarkRun = {
  runId: "r", datasetId: "swe-prbench", instanceId: "i", snapshotId: "s", experimentId: "e",
  architecture: "agentless", producedFindings: [finding("f1", "SQL injection"), finding("f1b", "SQL injection")], groundTruth: [],
};
const comments = new Map<string, GoldenComment[]>([["i", [{ id: "i-gc-0", body: "sql injection" }]]]);

test("judges each unique (finding, comment) pair once and skips cached", async () => {
  let calls = 0;
  const provider = new MockProvider({ responder: () => { calls += 1; return { text: '{"score":1}' }; } });
  const cache = new CoverageScoreCache();
  const pre = new CoverageJudgePrecomputer(provider, DEFAULT_JUDGE_CONFIG);
  await pre.precompute([run], comments, cache);
  // f1 and f1b are duplicates (same file/line/title) → 1 unique finding × 1 comment = 1 call.
  assert.equal(calls, 1);
  await pre.precompute([run], comments, cache); // all cached now
  assert.equal(calls, 1);
});

test("a parse failure leaves no cache entry", async () => {
  const provider = new MockProvider({ responder: () => ({ text: "not json" }) });
  const cache = new CoverageScoreCache();
  await new CoverageJudgePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([run], comments, cache);
  assert.deepEqual(cache.toJSON(), {});
});
