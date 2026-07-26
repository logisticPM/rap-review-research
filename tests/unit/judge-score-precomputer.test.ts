import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { BenchmarkRun, GroundTruthIssue } from "../../src/benchmark/index.ts";
import { SemanticScoreCache } from "../../src/benchmark/matching/semantic-score-cache.ts";
import { JudgeScorePrecomputer } from "../../src/benchmark/matching/judge-score-precomputer.ts";
import { DEFAULT_JUDGE_CONFIG } from "../../src/benchmark/matching/judge-prompt.ts";
import { MockProvider } from "../../src/llm/provider/mock-provider.ts";

function finding(file: string, line: number, title: string): ReviewFinding {
  return { id: `${file}:${line}`, title, category: "correctness", severity: "high", file, line, description: "d", recommendation: "r", confidence: 0.8 };
}
function run(producedFindings: ReviewFinding[], groundTruth: GroundTruthIssue[]): BenchmarkRun {
  return { runId: "r", datasetId: "ds", instanceId: "i", snapshotId: "s", experimentId: "e", architecture: "agentless", producedFindings, groundTruth };
}
const gt: GroundTruthIssue = { id: "g1", file: "a.ts", lineStart: 10, lineEnd: 12 };

test("judges only same-file, non-overlapping pairs and caches the score", async () => {
  let calls = 0;
  const provider = new MockProvider({ onReview: () => { calls += 1; }, responder: () => ({ text: '{"score": 0.9}' }) });
  const cache = new SemanticScoreCache();
  const r = run(
    [
      finding("a.ts", 99, "X"),  // same file, no overlap -> candidate
      finding("b.ts", 1, "Y"),   // different file -> skip
      finding("a.ts", 11, "Z"),  // overlaps [10,12] -> skip
    ],
    [gt],
  );
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  assert.equal(calls, 1);
  assert.equal(cache.get(finding("a.ts", 99, "X"), gt), 0.9);
});

test("skips already-cached pairs (no duplicate judging)", async () => {
  let calls = 0;
  const provider = new MockProvider({ onReview: () => { calls += 1; }, responder: () => ({ text: '{"score": 0.9}' }) });
  const cache = new SemanticScoreCache();
  const r = run([finding("a.ts", 99, "X")], [gt]);
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  assert.equal(calls, 1);
});

test("parse failure leaves no cache entry", async () => {
  const provider = new MockProvider({ responder: () => ({ text: "garbage" }) });
  const cache = new SemanticScoreCache();
  const r = run([finding("a.ts", 99, "X")], [gt]);
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache);
  assert.equal(cache.has(finding("a.ts", 99, "X"), gt), false);
});

test("a provider error propagates (fail-fast; caller can retry to resume)", async () => {
  const provider = new MockProvider({ failWith: new Error("boom") });
  const cache = new SemanticScoreCache();
  const r = run([finding("a.ts", 99, "X")], [gt]);
  await assert.rejects(() => new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([r], cache), /boom/);
});

test("empty findings or ground truth is a no-op", async () => {
  let calls = 0;
  const provider = new MockProvider({ onReview: () => { calls += 1; }, responder: () => ({ text: '{"score": 0.9}' }) });
  const cache = new SemanticScoreCache();
  await new JudgeScorePrecomputer(provider, DEFAULT_JUDGE_CONFIG).precompute([run([], []), run([finding("a.ts", 99, "X")], [])], cache);
  assert.equal(calls, 0);
});
