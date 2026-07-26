import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExperimentComparison } from "../../src/evaluation/models/experiment-comparison.ts";
import type { ExperimentMetrics } from "../../src/evaluation/models/experiment-metrics.ts";
import type { ReviewArchitecture } from "../../src/models/experiment.ts";

import {
  createExportService,
  ExportService,
  InMemoryExporterRegistry,
  CsvExperimentExporter,
  JsonExperimentExporter,
  STABLE_COLUMNS,
  toResearchExportRows,
  exportFileName,
  UnsupportedExportFormatError,
} from "../../src/export/index.ts";

const GENERATED_AT = "2026-06-28T12:00:00.000Z";

interface MetricsOverrides {
  readonly architecture?: ReviewArchitecture;
  readonly experimentId?: string;
  readonly findingCount?: number;
  readonly averageConfidence?: number;
  readonly evidenceScore?: number;
  readonly architectureAgreement?: number;
  readonly acceptedFindingRate?: number;
  readonly laterFixRate?: number;
}

function buildMetrics(overrides: MetricsOverrides = {}): ExperimentMetrics {
  return {
    experimentId: overrides.experimentId ?? "exp-1",
    architecture: overrides.architecture ?? "agentless",
    reviewQuality: {
      findingCount: overrides.findingCount ?? 3,
      lowSeverityCount: 1,
      mediumSeverityCount: 1,
      highSeverityCount: 1,
      criticalSeverityCount: 0,
      averageConfidence: overrides.averageConfidence ?? 0.75,
      duplicateFindingCount: 0,
    },
    operationalCost: {
      latencyMs: 1200,
      criticalPathLatencyMs: 1200,
      truncatedCallCount: 0,
      inputTokens: 500,
      outputTokens: 250,
      estimatedCostUsd: 0.0123,
      llmCalls: 1,
      messageCount: 2,
    },
    researchEvidence: {
      evidenceScore: overrides.evidenceScore ?? 0.8,
      architectureAgreement: overrides.architectureAgreement,
      acceptedFindingRate: overrides.acceptedFindingRate,
      laterFixRate: overrides.laterFixRate,
    },
  };
}

function buildComparison(
  snapshotId: string,
  architectures: ExperimentMetrics[],
): ExperimentComparison {
  return { experimentId: snapshotId, architectures };
}

function sampleInput() {
  return {
    generatedAt: GENERATED_AT,
    comparisons: [
      buildComparison("snap-1", [
        buildMetrics({ architecture: "agentless" }),
        buildMetrics({
          architecture: "hierarchical",
          architectureAgreement: 0.5,
        }),
      ]),
    ],
  };
}

test("CSV export writes a header in the stable column order", async () => {
  const exporter = new CsvExperimentExporter();
  const result = await exporter.export(sampleInput());
  const [header] = result.content.split("\n");
  assert.equal(header, STABLE_COLUMNS.join(","));
  // 21 (base + criticalPathLatencyMs (B3) + truncatedCallCount (B2))
  // + staticAnalysisAgreement + llmJudgeValidation (industrial, additive) = 23.
  assert.equal(STABLE_COLUMNS.length, 23);
  assert.ok(STABLE_COLUMNS.includes("criticalPathLatencyMs"));
  assert.ok(STABLE_COLUMNS.includes("truncatedCallCount"));
  assert.ok(STABLE_COLUMNS.includes("staticAnalysisAgreement"));
  assert.ok(STABLE_COLUMNS.includes("llmJudgeValidation"));
});

test("CSV export emits one row per architecture per comparison", async () => {
  const exporter = new CsvExperimentExporter();
  const input = {
    generatedAt: GENERATED_AT,
    comparisons: [
      buildComparison("snap-1", [
        buildMetrics({ architecture: "agentless" }),
        buildMetrics({ architecture: "hierarchical" }),
      ]),
      buildComparison("snap-2", [buildMetrics({ architecture: "consensus" })]),
    ],
  };
  const result = await exporter.export(input);
  const lines = result.content.split("\n");
  // 1 header + 3 data rows
  assert.equal(lines.length, 4);
  assert.equal(result.rowCount, 3);
  assert.equal(result.format, "csv");
});

test("CSV renders undefined optional columns as empty strings", async () => {
  const exporter = new CsvExperimentExporter();
  const result = await exporter.export(sampleInput());
  const lines = result.content.split("\n");
  const firstRow = lines[1]!.split(",");
  // agentless row: architectureAgreement/acceptedFindingRate/laterFixRate all undefined
  const agreementIdx = STABLE_COLUMNS.indexOf("architectureAgreement");
  const acceptedIdx = STABLE_COLUMNS.indexOf("acceptedFindingRate");
  const fixIdx = STABLE_COLUMNS.indexOf("laterFixRate");
  const staticIdx = STABLE_COLUMNS.indexOf("staticAnalysisAgreement");
  const judgeIdx = STABLE_COLUMNS.indexOf("llmJudgeValidation");
  assert.equal(firstRow[agreementIdx], "");
  assert.equal(firstRow[acceptedIdx], "");
  assert.equal(firstRow[fixIdx], "");
  assert.equal(firstRow[staticIdx], "");
  assert.equal(firstRow[judgeIdx], "");
});

test("CSV preserves numbers verbatim", async () => {
  const exporter = new CsvExperimentExporter();
  const result = await exporter.export(sampleInput());
  const lines = result.content.split("\n");
  const firstRow = lines[1]!.split(",");
  const costIdx = STABLE_COLUMNS.indexOf("estimatedCostUsd");
  const confidenceIdx = STABLE_COLUMNS.indexOf("averageConfidence");
  assert.equal(firstRow[costIdx], "0.0123");
  assert.equal(firstRow[confidenceIdx], "0.75");
});

test("CSV escapes commas, quotes, and newlines in string cells", async () => {
  // architecture value carries the special characters via a crafted comparison.
  const exporter = new CsvExperimentExporter();
  const nasty = 'weird,arch "x"\nline';
  const input = {
    generatedAt: GENERATED_AT,
    comparisons: [
      buildComparison("snap,\"1\"\n", [
        buildMetrics({
          architecture: nasty as ReviewArchitecture,
          experimentId: "exp-1",
        }),
      ]),
    ],
  };
  const result = await exporter.export(input);
  // snapshotId cell must be quoted and its inner quotes doubled.
  assert.ok(result.content.includes('"snap,""1""\n"'));
  // architecture cell must be quoted with doubled inner quotes.
  assert.ok(result.content.includes('"weird,arch ""x""\nline"'));
});

test("CSV handles an empty comparison set: header only, zero rows", async () => {
  const exporter = new CsvExperimentExporter();
  const result = await exporter.export({
    generatedAt: GENERATED_AT,
    comparisons: [],
  });
  assert.equal(result.content, STABLE_COLUMNS.join(","));
  assert.equal(result.rowCount, 0);
});

test("JSON export preserves the full comparison structure", async () => {
  const exporter = new JsonExperimentExporter();
  const input = sampleInput();
  const result = await exporter.export(input);
  const parsed = JSON.parse(result.content);
  // JSON.stringify drops `undefined` keys; compare against the same round-trip.
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(input.comparisons)));
  assert.equal(result.format, "json");
  // rowCount = total architecture entries across comparisons
  assert.equal(result.rowCount, 2);
});

test("exportFileName sanitizes the timestamp and uses the format extension", () => {
  assert.equal(
    exportFileName("csv", GENERATED_AT),
    "experiment-comparisons-2026-06-28T12-00-00-000Z.csv",
  );
  assert.equal(
    exportFileName("json", GENERATED_AT),
    "experiment-comparisons-2026-06-28T12-00-00-000Z.json",
  );
});

test("toResearchExportRows maps experimentId to snapshotId", () => {
  const rows = toResearchExportRows(sampleInput().comparisons);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.snapshotId, "snap-1");
  assert.equal(rows[0]!.architecture, "agentless");
});

test("registry resolves registered exporters and rejects unknown formats", () => {
  const registry = new InMemoryExporterRegistry();
  registry.register(new CsvExperimentExporter());
  assert.ok(registry.get("csv") instanceof CsvExperimentExporter);
  assert.throws(
    () => registry.get("json"),
    (error: unknown) => error instanceof UnsupportedExportFormatError,
  );
});

test("ExportService dispatches to the correct exporter by format", async () => {
  const service = createExportService();
  const csv = await service.exportComparisons(sampleInput(), "csv");
  const json = await service.exportComparisons(sampleInput(), "json");
  assert.equal(csv.format, "csv");
  assert.equal(json.format, "json");
});

test("ExportService throws UnsupportedExportFormatError for an unknown format", async () => {
  const service = new ExportService(new InMemoryExporterRegistry());
  await assert.rejects(
    () => service.exportComparisons(sampleInput(), "csv"),
    (error: unknown) => error instanceof UnsupportedExportFormatError,
  );
});
