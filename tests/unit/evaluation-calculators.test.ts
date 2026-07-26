import { test } from "node:test";
import assert from "node:assert/strict";

import { FindingMetricsCalculator } from "../../src/evaluation/finding-metrics.ts";
import { CostMetricsCalculator } from "../../src/evaluation/cost-metrics.ts";
import type { StoredExperimentResult } from "../../src/storage/stored-models.ts";
import { buildStoredResult, buildFinding } from "./support/stored-results.ts";

const finding = new FindingMetricsCalculator();
const cost = new CostMetricsCalculator();

test("counts findings by severity", () => {
  const result = buildStoredResult({
    findings: [
      buildFinding({ id: "1", severity: "low" }),
      buildFinding({ id: "2", severity: "medium" }),
      buildFinding({ id: "3", severity: "high" }),
      buildFinding({ id: "4", severity: "critical" }),
      buildFinding({ id: "5", severity: "high" }),
    ],
  });
  const m = finding.calculate(result);
  assert.equal(m.findingCount, 5);
  assert.equal(m.lowSeverityCount, 1);
  assert.equal(m.mediumSeverityCount, 1);
  assert.equal(m.highSeverityCount, 2);
  assert.equal(m.criticalSeverityCount, 1);
});

test("averages confidence and handles zero findings", () => {
  const m = finding.calculate(
    buildStoredResult({
      findings: [
        buildFinding({ id: "1", confidence: 0.6 }),
        buildFinding({ id: "2", confidence: 0.8 }),
      ],
    }),
  );
  assert.ok(Math.abs(m.averageConfidence - 0.7) < 1e-9);

  const empty = finding.calculate(buildStoredResult({ findings: [] }));
  assert.equal(empty.findingCount, 0);
  assert.equal(empty.averageConfidence, 0);
  assert.equal(empty.duplicateFindingCount, 0);
});

test("detects duplicate findings by file+line+title", () => {
  const m = finding.calculate(
    buildStoredResult({
      findings: [
        buildFinding({ id: "1", file: "a.ts", line: 10, title: "Bug" }),
        buildFinding({ id: "2", file: "a.ts", line: 10, title: "bug" }), // dup (case-insensitive)
        buildFinding({ id: "3", file: "b.ts", line: 10, title: "Bug" }), // different file
      ],
    }),
  );
  assert.equal(m.findingCount, 3);
  assert.equal(m.duplicateFindingCount, 1);
});

test("copies operational cost from the validated result", () => {
  const m = cost.calculate(
    buildStoredResult({
      latencyMs: 1234,
      inputTokens: 700,
      outputTokens: 90,
      estimatedCostUsd: 0.0321,
      llmCalls: 1,
      messageCount: 2,
    }),
  );
  assert.deepEqual(m, {
    latencyMs: 1234,
    criticalPathLatencyMs: 1234, // falls back to latencyMs (no critical path stored)
    truncatedCallCount: 0, // none stored → 0
    inputTokens: 700,
    outputTokens: 90,
    estimatedCostUsd: 0.0321,
    llmCalls: 1,
    messageCount: 2,
  });
});

test("cost calculator falls back to the raw result when validated is absent", () => {
  const rawOnly: StoredExperimentResult = {
    experimentId: "e",
    rawResult: {
      experimentId: "e",
      architecture: "agentless",
      rawOutput: "x",
      summary: "",
      findings: [],
      inputTokens: 7,
      outputTokens: 3,
      latencyMs: 50,
      estimatedCostUsd: 0.002,
      llmCalls: 1,
      messageCount: 1,
      storedAt: "2026-07-02T00:00:00.000Z",
    },
    validatedResult: null,
    findings: [],
  };
  const m = cost.calculate(rawOnly);
  assert.equal(m.inputTokens, 7);
  assert.equal(m.estimatedCostUsd, 0.002);
});
