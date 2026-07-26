import { test } from "node:test";
import assert from "node:assert/strict";

import { ValidationEngine } from "../../src/validation/validation-engine.ts";
import {
  JSONExtractionError,
  SchemaValidationError,
  NormalizationError,
} from "../../src/validation/validation-errors.ts";
import { SCHEMA_VERSION } from "../../src/validation/schemas/review-result-schema.ts";
import type { RawReviewResult } from "../../src/models/review-result.ts";

/** Build a RawReviewResult carrying the given rawOutput. */
function rawWith(rawOutput: unknown): RawReviewResult {
  return {
    architecture: "agentless",
    summary: "",
    findings: [],
    rawOutput,
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    estimatedCostUsd: 0.001,
    messageCount: 1,
    llmCalls: 1,
  };
}

const FINDING = {
  title: "Missing authorization check",
  severity: "high",
  category: "security",
  file: "src/api/reports.ts",
  line: 42,
  description: "No ownership check before update.",
  recommendation: "Check report ownership.",
  confidence: 0.9,
};

const engine = new ValidationEngine();

test("accepts markdown-fenced JSON and records the repair", async () => {
  const result = await engine.validate(
    rawWith('```json\n{"summary":"ok","findings":[]}\n```'),
    { promptVersion: "v1" },
  );
  assert.equal(result.summary, "ok");
  assert.deepEqual(result.findings, []);
  assert.equal(result.validation.repaired, true);
  assert.ok(
    result.validation.repairActions.includes("removed markdown code fences"),
  );
});

test("accepts JSON surrounded by commentary", async () => {
  const result = await engine.validate(
    rawWith('Sure!\n{"summary":"ok","findings":[]}\nHope that helps.'),
  );
  assert.equal(result.summary, "ok");
  assert.ok(
    result.validation.repairActions.includes(
      "extracted JSON object from surrounding text",
    ),
  );
});

test("carries execution metrics through and stamps metadata", async () => {
  const result = await engine.validate(
    rawWith('{"summary":"ok","findings":[]}'),
    { promptVersion: "prompt-v1", experimentId: "exp_1" },
  );
  assert.equal(result.latencyMs, 100);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.estimatedCostUsd, 0.001);
  assert.equal(result.llmCalls, 1);
  assert.equal(result.messageCount, 1);
  assert.equal(result.validation.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.validation.promptVersion, "prompt-v1");
  assert.equal(result.validation.validationPassed, true);
});

test("validates a finding and assigns a deterministic id", async () => {
  const result = await engine.validate(
    rawWith(JSON.stringify({ summary: "s", findings: [FINDING] })),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.id, "finding-1");
  assert.equal(result.findings[0]?.severity, "high");
});

test("normalizes severity and category casing", async () => {
  const result = await engine.validate(
    rawWith(
      JSON.stringify({
        summary: "s",
        findings: [{ ...FINDING, severity: "HIGH", category: "Security" }],
      }),
    ),
  );
  assert.equal(result.findings[0]?.severity, "high");
  assert.equal(result.findings[0]?.category, "security");
  assert.ok(
    result.validation.repairActions.includes("normalized severity casing"),
  );
  assert.ok(
    result.validation.repairActions.includes("normalized category casing"),
  );
});

test("clamps confidence into [0, 1]", async () => {
  const high = await engine.validate(
    rawWith(JSON.stringify({ summary: "s", findings: [{ ...FINDING, confidence: 1.5 }] })),
  );
  assert.equal(high.findings[0]?.confidence, 1);

  const low = await engine.validate(
    rawWith(JSON.stringify({ summary: "s", findings: [{ ...FINDING, confidence: -0.3 }] })),
  );
  assert.equal(low.findings[0]?.confidence, 0);
  assert.ok(low.validation.repairActions.includes("clamped confidence to [0, 1]"));
});

test("accepts a structured object rawOutput with no repair", async () => {
  const result = await engine.validate(
    rawWith({
      summary: "clean",
      findings: [{ ...FINDING, id: "f1" }],
    }),
  );
  assert.equal(result.validation.repaired, false);
  assert.deepEqual(result.validation.repairActions, []);
  assert.equal(result.findings[0]?.id, "f1");
});

test("rejects malformed JSON", async () => {
  await assert.rejects(
    () => engine.validate(rawWith("```json\n{ not: valid, }\n```")),
    JSONExtractionError,
  );
});

test("drops a malformed finding but keeps the valid ones (fairness)", async () => {
  const { recommendation, ...withoutRecommendation } = FINDING;
  void recommendation;
  const result = await engine.validate(
    rawWith(
      JSON.stringify({ summary: "s", findings: [FINDING, withoutRecommendation] }),
    ),
  );
  // The valid finding survives; the one missing `recommendation` is dropped —
  // one bad finding must not discard the whole review (single-call fairness).
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, FINDING.title);
  assert.equal(result.validation.repaired, true);
  assert.ok(
    result.validation.repairActions.some((a) => a.includes("malformed finding")),
  );
});

test("still rejects a structurally broken envelope", async () => {
  await assert.rejects(
    () =>
      engine.validate(
        rawWith(JSON.stringify({ summary: "s", findings: "not-an-array" })),
      ),
    SchemaValidationError,
  );
});

test("rejects an unrecognized severity (does not invent one)", async () => {
  await assert.rejects(
    () =>
      engine.validate(
        rawWith(JSON.stringify({ summary: "s", findings: [{ ...FINDING, severity: "moderate" }] })),
      ),
    NormalizationError,
  );
});

test("rejects raw output that is neither text nor an object", async () => {
  await assert.rejects(() => engine.validate(rawWith(42)), JSONExtractionError);
});
