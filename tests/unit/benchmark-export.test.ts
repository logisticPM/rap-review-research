import { test } from "node:test";
import assert from "node:assert/strict";

import type { BenchmarkResult } from "../../src/benchmark/index.ts";
import {
  BENCHMARK_STABLE_COLUMNS,
  toBenchmarkExportRows,
  BenchmarkCsvExporter,
  benchmarkResultsToCsv,
} from "../../src/benchmark/index.ts";

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    runId: "qodo-1#agentless",
    datasetId: "qodo",
    instanceId: "qodo-1",
    snapshotId: "snap_1",
    experimentId: "snap_1#agentless#m#v1#w1#e1",
    architecture: "agentless",
    groundTruthCount: 2,
    producedCount: 3,
    uniqueProducedCount: 2,
    truePositives: 1,
    falsePositives: 2,
    falseNegatives: 1,
    precision: 0.3333,
    uniquePrecision: 0.5,
    recall: 0.5,
    f1: 0.4,
    localizationAccuracy: 1,
    snippetLocalizationAccuracy: 1,
    ...overrides,
  };
}

test("export rows include the benchmark metrics", () => {
  const rows = toBenchmarkExportRows([result()]);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.precision, 0.3333);
  assert.equal(row.recall, 0.5);
  assert.equal(row.f1, 0.4);
  assert.equal(row.localizationAccuracy, 1);
  assert.equal(row.truePositives, 1);
  assert.equal(row.falsePositives, 2);
  assert.equal(row.falseNegatives, 1);
});

test("CSV has the stable header and one row per result", () => {
  const csv = new BenchmarkCsvExporter().export(
    [result({ architecture: "agentless" }), result({ architecture: "hierarchical" })],
    "2026-07-02T12:00:00.000Z",
  );
  const lines = csv.content.split("\n");
  assert.equal(lines[0], BENCHMARK_STABLE_COLUMNS.join(","));
  assert.ok(BENCHMARK_STABLE_COLUMNS.includes("precision"));
  assert.ok(BENCHMARK_STABLE_COLUMNS.includes("localizationAccuracy"));
  assert.equal(lines.length, 3); // header + 2 rows
  assert.equal(csv.rowCount, 2);
  assert.equal(csv.fileName, "benchmark-results-2026-07-02T12-00-00-000Z.csv");
});

test("CSV preserves numbers verbatim and escapes special characters", () => {
  const csv = benchmarkResultsToCsv(
    [result({ instanceId: 'inst,"x"', precision: 0.25 })],
    "t",
  );
  const dataRow = csv.split("\n")[1]!;
  const cols = BENCHMARK_STABLE_COLUMNS;
  const cells = dataRow.split(",");
  // precision cell is verbatim number (find its position via a clean row).
  assert.ok(csv.includes("0.25"));
  // the instanceId with comma+quotes must be quoted with doubled quotes
  assert.ok(csv.includes('"inst,""x"""'));
  assert.equal(cols[0], "datasetId");
  assert.ok(cells.length >= cols.length); // quoting introduced no column loss beyond the escaped field
});
