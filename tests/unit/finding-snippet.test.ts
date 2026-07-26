import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSpecialistReview } from "../../src/architectures/shared/review-specialist.ts";
import { ResultNormalizer } from "../../src/validation/result-normalizer.ts";
import type { ReviewFindingInput } from "../../src/validation/schemas/review-finding-schema.ts";

const SNIPPET = "const rows = await db.query('SELECT * FROM users WHERE id = ' + id)";

function findingInput(overrides: Partial<ReviewFindingInput> = {}): ReviewFindingInput {
  return {
    title: "SQL injection",
    severity: "high",
    category: "security",
    file: "src/db.ts",
    line: 11,
    description: "d",
    recommendation: "r",
    confidence: 0.8,
    ...overrides,
  };
}

test("specialist parser captures the verbatim snippet (A3)", () => {
  const json = JSON.stringify({
    summary: "s",
    findings: [
      {
        title: "SQL injection",
        severity: "high",
        category: "security",
        file: "src/db.ts",
        line: 11,
        snippet: SNIPPET,
        description: "d",
        recommendation: "r",
        confidence: 0.8,
      },
    ],
  });
  const { findings } = parseSpecialistReview(json, "backend");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.snippet, SNIPPET);
});

test("normalizer carries a snippet through unchanged (A3)", () => {
  const result = new ResultNormalizer().normalize({
    summary: "s",
    findings: [findingInput({ snippet: SNIPPET })],
  });
  assert.equal(result.findings[0]?.snippet, SNIPPET);
});

test("normalizer tolerates a missing snippet (A3, backward compatible)", () => {
  const result = new ResultNormalizer().normalize({
    summary: "s",
    findings: [findingInput()],
  });
  assert.equal(result.findings[0]?.snippet, undefined);
});
