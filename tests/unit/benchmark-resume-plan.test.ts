import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewArchitecture } from "../../src/models/experiment.ts";
import type { BenchmarkRun } from "../../src/benchmark/index.ts";
import { planInstanceResume } from "../../src/benchmark/index.ts";

const ARCHS: ReviewArchitecture[] = [
  "agentless",
  "generalists-3",
  "hierarchical",
  "consensus",
];

/** Build one BenchmarkRun for (instance, arch, run). Only the fields the plan reads matter. */
function run(instanceId: string, architecture: ReviewArchitecture, n: number): BenchmarkRun {
  return {
    runId: `${instanceId}#${architecture}#${n}`,
    datasetId: "qodo",
    instanceId,
    snapshotId: "snap",
    experimentId: `exp-${instanceId}-${architecture}-${n}`,
    architecture,
    producedFindings: [],
    groundTruth: [],
  };
}

/** All 4 archs × `runs` runs for one instance = a complete instance at expected=4×runs. */
function completeInstance(instanceId: string, runs: number): BenchmarkRun[] {
  const out: BenchmarkRun[] = [];
  for (const arch of ARCHS) {
    for (let n = 1; n <= runs; n += 1) out.push(run(instanceId, arch, n));
  }
  return out;
}

const EXPECTED = ARCHS.length * 3; // 12

test("all instances complete → carry everything, regenerate nothing", () => {
  const prior = [...completeInstance("A", 3), ...completeInstance("B", 3)];
  const plan = planInstanceResume(prior, ["A", "B"], EXPECTED);

  assert.deepEqual(plan.instanceIdsToRun, []);
  assert.deepEqual(plan.completeInstanceIds, ["A", "B"]);
  assert.equal(plan.carriedRuns.length, 24);
});

test("a fully-missing instance (cap-failed before it ran) is regenerated; complete ones carried", () => {
  // A complete (12 runs), B never ran (0 runs, absent from prior).
  const prior = completeInstance("A", 3);
  const plan = planInstanceResume(prior, ["A", "B"], EXPECTED);

  assert.deepEqual(plan.instanceIdsToRun, ["B"]);
  assert.deepEqual(plan.completeInstanceIds, ["A"]);
  assert.equal(plan.carriedRuns.length, 12);
  assert.ok(plan.carriedRuns.every((r) => r.instanceId === "A"));
});

test("a near-miss instance (11/12, one flaky failure) is regenerated whole, its partial runs dropped", () => {
  const partialA = completeInstance("A", 3).slice(0, 11); // 11 of 12
  const prior = [...partialA, ...completeInstance("B", 3)];
  const plan = planInstanceResume(prior, ["A", "B"], EXPECTED);

  assert.deepEqual(plan.instanceIdsToRun, ["A"]);
  assert.deepEqual(plan.completeInstanceIds, ["B"]);
  // A's 11 partial runs are NOT carried (they'll be replaced by a fresh full set).
  assert.ok(plan.carriedRuns.every((r) => r.instanceId === "B"));
  assert.equal(plan.carriedRuns.length, 12);
});

test("stale prior runs for instances no longer in the chunk are dropped, not carried", () => {
  const prior = [...completeInstance("A", 3), ...completeInstance("STALE", 3)];
  const plan = planInstanceResume(prior, ["A", "B"], EXPECTED);

  assert.deepEqual(plan.instanceIdsToRun, ["B"]);
  assert.deepEqual(plan.completeInstanceIds, ["A"]);
  assert.ok(plan.carriedRuns.every((r) => r.instanceId === "A"));
  assert.equal(plan.carriedRuns.length, 12);
});

test("empty prior runs → every intended instance is regenerated (fresh chunk)", () => {
  const plan = planInstanceResume([], ["A", "B", "C"], EXPECTED);

  assert.deepEqual(plan.instanceIdsToRun, ["A", "B", "C"]);
  assert.deepEqual(plan.completeInstanceIds, []);
  assert.equal(plan.carriedRuns.length, 0);
});

test("intended order is preserved in both partitions", () => {
  const prior = [...completeInstance("B", 3)]; // only B complete
  const plan = planInstanceResume(prior, ["A", "B", "C", "D"], EXPECTED);

  assert.deepEqual(plan.completeInstanceIds, ["B"]);
  assert.deepEqual(plan.instanceIdsToRun, ["A", "C", "D"]);
});
