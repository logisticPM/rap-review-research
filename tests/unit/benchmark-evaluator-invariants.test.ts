import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import type { BenchmarkRun, GroundTruthIssue } from "../../src/benchmark/index.ts";
import { GroundTruthEvaluator } from "../../src/benchmark/index.ts";
import { buildFinding } from "./support/stored-results.ts";

/**
 * Metamorphic / invariant suite for the ground-truth evaluator (roadmap A6).
 *
 * These pin the properties the correctness fixes rely on, so a future change to
 * the matcher or evaluator cannot silently break them. Deterministic, LLM-free.
 * The off-by-N snippet-anchoring invariant is intentionally deferred until A3
 * (snippet-anchored localization) lands.
 */

const evaluator = new GroundTruthEvaluator();

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

/** Ground truth projected back into findings at the start of each issue span. */
function findingsFromGroundTruth(gt: GroundTruthIssue[]): ReviewFinding[] {
  return gt.map((g, i) =>
    buildFinding({ id: `f${i}`, file: g.file, line: g.lineStart, title: `t${i}` }),
  );
}

const GT: GroundTruthIssue[] = [
  { id: "g1", file: "src/a.ts", lineStart: 10, lineEnd: 12 },
  { id: "g2", file: "src/b.ts", lineStart: 5, lineEnd: 7 },
  { id: "g3", file: "src/c.ts", lineStart: 20, lineEnd: 20 },
];

test("feeding ground truth back as findings yields P=R=F1=1", () => {
  const r = evaluator.evaluate(run(findingsFromGroundTruth(GT), GT));
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.f1, 1);
  assert.equal(r.uniquePrecision, 1);
  assert.equal(r.localizationAccuracy, 1);
});

test("empty findings produce zeros with no NaN anywhere", () => {
  const r = evaluator.evaluate(run([], GT));
  for (const v of [
    r.precision,
    r.recall,
    r.f1,
    r.uniquePrecision,
    r.localizationAccuracy,
  ]) {
    assert.equal(Number.isNaN(v), false);
    assert.equal(v, 0);
  }
  assert.equal(r.falseNegatives, GT.length);
});

test("no ground truth produces no NaN and zero recall", () => {
  const r = evaluator.evaluate(run(findingsFromGroundTruth(GT), []));
  assert.equal(Number.isNaN(r.precision), false);
  assert.equal(Number.isNaN(r.recall), false);
  assert.equal(r.recall, 0);
  assert.equal(r.falsePositives, 3);
});

test("metrics are invariant to the order of produced findings (A1)", () => {
  const findings = findingsFromGroundTruth(GT);
  const forward = evaluator.evaluate(run(findings, GT));
  const backward = evaluator.evaluate(run([...findings].reverse(), GT));
  assert.equal(forward.truePositives, backward.truePositives);
  assert.equal(forward.precision, backward.precision);
  assert.equal(forward.recall, backward.recall);
  assert.equal(forward.localizationAccuracy, backward.localizationAccuracy);
});

test("duplicates: recall stable, raw precision drops, unique precision stable (A5)", () => {
  const one = findingsFromGroundTruth([GT[0] as GroundTruthIssue]);
  const clean = evaluator.evaluate(run(one, GT));
  // Add two paraphrase near-duplicates of the same true finding.
  const withDupes = [
    ...one,
    buildFinding({ id: "d1", file: "src/a.ts", line: 11, title: "t0 restated" }),
    buildFinding({ id: "d2", file: "src/a.ts", line: 10, title: "t0" }),
  ];
  const dup = evaluator.evaluate(run(withDupes, GT));

  assert.equal(dup.recall, clean.recall); // same real issue found
  assert.ok(dup.precision < clean.precision); // extra reports counted raw
  assert.equal(dup.uniquePrecision, clean.uniquePrecision); // collapsed
  assert.equal(dup.uniqueProducedCount, 1);
});

test("golden fixture: exact metric row for a known instance", () => {
  // 3 issues; f1 localizes g1, f2 hits g2's file wrong line, f3 is off-file.
  const findings = [
    buildFinding({ id: "f1", file: "src/a.ts", line: 11, title: "a" }), // TP g1
    buildFinding({ id: "f2", file: "src/b.ts", line: 99, title: "b" }), // detected g2, not localized
    buildFinding({ id: "f3", file: "src/z.ts", line: 1, title: "z" }), // pure FP
  ];
  const r = evaluator.evaluate(run(findings, GT));
  assert.equal(r.groundTruthCount, 3);
  assert.equal(r.producedCount, 3);
  assert.equal(r.uniqueProducedCount, 3);
  assert.equal(r.truePositives, 1);
  assert.equal(r.falsePositives, 2);
  assert.equal(r.falseNegatives, 2);
  assert.equal(round(r.precision), 0.3333);
  assert.equal(round(r.recall), 0.3333);
  assert.equal(round(r.uniquePrecision), 0.3333);
  // Detected at file level: g1 (f1) and g2 (f2) = 2; localized = 1 → 0.5.
  assert.equal(round(r.localizationAccuracy), 0.5);
});

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
