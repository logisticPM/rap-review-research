import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { BenchmarkRun, GroundTruthIssue } from "../../src/benchmark/index.ts";
import {
  GroundTruthEvaluator,
  BenchmarkEvaluator,
  IssueMatcher,
} from "../../src/benchmark/index.ts";
import { SemanticScoreCache } from "../../src/benchmark/matching/semantic-score-cache.ts";
import { CachedSemanticMatcher } from "../../src/benchmark/matching/cached-semantic-matcher.ts";

function finding(file: string, line: number): ReviewFinding {
  return {
    id: `${file}:${line}`,
    title: "issue",
    category: "correctness",
    severity: "high",
    file,
    line,
    description: "d",
    recommendation: "r",
    confidence: 0.8,
  };
}

function finding2(file: string, line: number, title: string): ReviewFinding {
  return { ...finding(file, line), id: `${file}:${line}:${title}`, title };
}

function run(
  producedFindings: ReviewFinding[],
  groundTruth: GroundTruthIssue[],
): BenchmarkRun {
  return {
    runId: "r#agentless",
    datasetId: "ds",
    instanceId: "r",
    snapshotId: "snap",
    experimentId: "snap#agentless#m#v1#w1#e1",
    architecture: "agentless",
    producedFindings,
    groundTruth,
  };
}

const GT: GroundTruthIssue[] = [
  { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 12 },
  { id: "g2", file: "src/b.ts", lineStart: 5, lineEnd: 5 },
];

test("computes precision, recall, F1, and localization accuracy", () => {
  // f1 hits g1 exactly; f2 hits g1's file but wrong line; f3 is off-file;
  // f4 hits g2's file but wrong line (detected, not localized).
  const findings = [
    finding("src/a.ts", 11), // TP for g1
    finding("src/a.ts", 50), // FP (file a.ts, no line overlap; g1 already taken)
    finding("src/c.ts", 1), // FP (unknown file)
    finding("src/b.ts", 99), // FP (file b.ts detected, no line overlap)
  ];
  const result = new GroundTruthEvaluator().evaluate(run(findings, GT));

  assert.equal(result.groundTruthCount, 2);
  assert.equal(result.producedCount, 4);
  assert.equal(result.truePositives, 1); // only f1↔g1
  assert.equal(result.falsePositives, 3);
  assert.equal(result.falseNegatives, 1); // g2 never localized

  assert.equal(round(result.precision), 0.25); // 1/4
  assert.equal(round(result.recall), 0.5); // 1/2
  assert.equal(round(result.f1), 0.3333); // 2PR/(P+R)
  // g1 and g2 both detected at file level (f1, f4); only g1 localized.
  assert.equal(round(result.localizationAccuracy), 0.5); // 1/2
});

test("perfect detection yields precision/recall/F1 = 1", () => {
  const findings = [finding("src/a.ts", 10), finding("src/b.ts", 5)];
  const result = new GroundTruthEvaluator().evaluate(run(findings, GT));
  assert.equal(result.truePositives, 2);
  assert.equal(result.falsePositives, 0);
  assert.equal(result.falseNegatives, 0);
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 1);
  assert.equal(result.f1, 1);
  assert.equal(result.localizationAccuracy, 1);
});

test("no produced findings yields zero precision/recall and all false negatives", () => {
  const result = new GroundTruthEvaluator().evaluate(run([], GT));
  assert.equal(result.truePositives, 0);
  assert.equal(result.falseNegatives, 2);
  assert.equal(result.precision, 0);
  assert.equal(result.recall, 0);
  assert.equal(result.f1, 0);
  assert.equal(result.localizationAccuracy, 0);
});

test("true-positive count is invariant to the order of findings (A1)", () => {
  // Two issues on different lines; three findings (two collide on g1, one hits
  // g2). The TP count must be the same whatever order the findings arrive in.
  const gt: GroundTruthIssue[] = [
    { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 10 },
    { id: "g2", file: "src/a.ts", lineStart: 20, lineEnd: 20 },
  ];
  const findings = [
    finding("src/a.ts", 10), // g1
    finding("src/a.ts", 10), // g1 (collision)
    finding("src/a.ts", 20), // g2
  ];
  const forward = new GroundTruthEvaluator().evaluate(run(findings, gt));
  const reversed = new GroundTruthEvaluator().evaluate(
    run([...findings].reverse(), gt),
  );
  assert.equal(forward.truePositives, reversed.truePositives);
  assert.equal(forward.truePositives, 2); // g1 and g2 both matched
});

test("maximum matching beats greedy first-fit (A1)", () => {
  // g1 spans lines 10-20; g2 spans 10-12. A finding at line 11 matches BOTH;
  // a finding at line 20 matches only g1. Greedy that pairs the line-11 finding
  // with g1 first would strand the line-20 finding (g1 taken) → 1 TP.
  // Maximum matching pairs line-20↔g1 and line-11↔g2 → 2 TP.
  const gt: GroundTruthIssue[] = [
    { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 20 },
    { id: "g2", file: "src/a.ts", lineStart: 10, lineEnd: 12 },
  ];
  const findings = [finding("src/a.ts", 11), finding("src/a.ts", 20)];
  const result = new GroundTruthEvaluator().evaluate(run(findings, gt));
  assert.equal(result.truePositives, 2);
});

test("a single finding cannot double-count against two issues", () => {
  // Two ground-truth issues in the same overlapping span; one finding.
  const overlapping: GroundTruthIssue[] = [
    { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 12 },
    { id: "g2", file: "src/a.ts", lineStart: 10, lineEnd: 12 },
  ];
  const result = new GroundTruthEvaluator().evaluate(
    run([finding("src/a.ts", 11)], overlapping),
  );
  assert.equal(result.truePositives, 1); // greedy one-to-one
  assert.equal(result.falseNegatives, 1);
});

test("duplicate findings drop raw precision but not unique precision or recall (A5)", () => {
  // One real issue (g1) found once, plus two extra near-duplicate reports of
  // the same true finding. Raw precision counts each duplicate as its own FP;
  // unique precision collapses them; recall is unaffected.
  const dupTitle = "Null dereference in handler";
  const findings = [
    finding2("src/a.ts", 10, dupTitle),
    finding2("src/a.ts", 10, dupTitle),
    finding2("src/a.ts", 11, "Null dereference in the handler"),
  ];
  const gt: GroundTruthIssue[] = [
    { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 12 },
  ];
  const result = new GroundTruthEvaluator().evaluate(run(findings, gt));

  assert.equal(result.producedCount, 3);
  assert.equal(result.uniqueProducedCount, 1); // all three collapse
  assert.equal(result.truePositives, 1);
  assert.equal(round(result.precision), 0.3333); // 1/3 raw
  assert.equal(result.uniquePrecision, 1); // 1/1 deduped
  assert.equal(result.recall, 1); // g1 still found
});

test("snippet anchoring recovers localization when the reported line is wrong (A3)", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,1 +10,1 @@",
    "-const safe = sanitize(input);",
    "+const danger = eval(input);",
    "",
  ].join("\n");
  const gt: GroundTruthIssue[] = [
    { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 10 },
  ];
  const misreported: ReviewFinding = {
    ...finding("src/a.ts", 99), // wrong reported line
    snippet: "const danger = eval(input);", // but the snippet is correct
  };
  const r = new GroundTruthEvaluator().evaluate({
    ...run([misreported], gt),
    rawDiff: diff,
  });
  // Raw line 99 misses the [10,10] issue; snippet re-anchors to line 10.
  assert.equal(r.truePositives, 0);
  assert.equal(r.localizationAccuracy, 0);
  assert.equal(r.snippetLocalizationAccuracy, 1);
});

test("snippet localization falls back to raw when no diff is provided (A3)", () => {
  const r = new GroundTruthEvaluator().evaluate(
    run([finding("src/a.ts", 10)], GT),
  );
  assert.equal(r.snippetLocalizationAccuracy, r.localizationAccuracy);
});

test("BenchmarkEvaluator macro-summarizes results per architecture", () => {
  const evaluator = new BenchmarkEvaluator();
  const results = [
    { ...new GroundTruthEvaluator().evaluate(run([finding("src/a.ts", 10)], GT)) },
    {
      ...new GroundTruthEvaluator().evaluate({
        ...run([finding("src/a.ts", 10), finding("src/b.ts", 5)], GT),
        architecture: "hierarchical",
      }),
    },
  ];
  const summary = evaluator.summarizeByArchitecture(results);
  assert.deepEqual(
    summary.map((s) => s.architecture),
    ["agentless", "hierarchical"],
  );
  const hier = summary.find((s) => s.architecture === "hierarchical")!;
  assert.equal(hier.instanceCount, 1);
  assert.equal(hier.meanRecall, 1);
});

test("semantic cache rescues a wrong-line finding, raising recall (A2)", () => {
  const gt: GroundTruthIssue[] = [{ id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 12 }];
  const wrongLine = finding("src/a.ts", 99); // right file, wrong line

  const strict = new GroundTruthEvaluator().evaluate(run([wrongLine], gt));
  assert.equal(strict.recall, 0);

  const cache = new SemanticScoreCache();
  cache.set(wrongLine, gt[0]!, 0.9);
  const semantic = new GroundTruthEvaluator({
    matcher: new IssueMatcher({ semanticMatcher: new CachedSemanticMatcher(cache), semanticThreshold: 0.7 }),
  }).evaluate(run([wrongLine], gt));
  assert.equal(semantic.recall, 1);
});

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
