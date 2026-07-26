import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import {
  parseAddedLines,
  StaticAnalysisReviewer,
  crossSourceCorroborate,
} from "../../src/architectures/static-analysis/index.ts";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,6 @@",
  " const x = 1;", // context, new line 1
  "-const old = 2;", // deletion (no new line)
  "+const y: any = 2;", // new line 2
  "+console.log(y);", // new line 3
  " const z = 3;", // context, new line 4
  "+eval(userInput);", // new line 5
  "@@ -10,2 +13,2 @@",
  " keep();", // new line 13
  "+// TODO: refactor this", // new line 14
].join("\n");

test("parseAddedLines: added lines get correct new-file line numbers; deletions skipped", () => {
  const added = parseAddedLines(DIFF);
  assert.deepEqual(
    added.map((a) => `${a.file}:${a.line}:${a.content}`),
    [
      "src/a.ts:2:const y: any = 2;",
      "src/a.ts:3:console.log(y);",
      "src/a.ts:5:eval(userInput);",
      "src/a.ts:14:// TODO: refactor this",
    ],
  );
});

test("StaticAnalysisReviewer flags the deterministic patterns with correct location", () => {
  const findings = new StaticAnalysisReviewer().review(DIFF);
  const byRule = new Map(findings.map((f) => [f.id, f]));
  // no-any + no-console + no-eval + todo-marker fire; each on its added line
  assert.ok(findings.some((f) => f.category === "security" && f.line === 5), "eval at line 5");
  assert.ok(findings.some((f) => f.title === "Explicit any type" && f.line === 2), "any at line 2");
  assert.ok(findings.some((f) => f.title === "console statement" && f.line === 3), "console at line 3");
  assert.ok(findings.some((f) => f.title === "Unresolved TODO/FIXME" && f.line === 14), "todo at line 14");
  // deterministic → confidence 1, snippet is the offending line
  const evalF = findings.find((f) => f.line === 5)!;
  assert.equal(evalF.confidence, 1);
  assert.equal(evalF.file, "src/a.ts");
  assert.equal(evalF.snippet, "eval(userInput);");
  assert.equal(byRule.size, findings.length); // ids unique
});

test("StaticAnalysisReviewer returns nothing on a clean diff", () => {
  const clean = [
    "diff --git a/b.ts b/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1,2 @@",
    " const a = 1;",
    "+const b = a + 1;",
  ].join("\n");
  assert.deepEqual(new StaticAnalysisReviewer().review(clean), []);
});

function f(file: string, line: number, title = "issue"): ReviewFinding {
  return { id: `${file}:${line}`, title, category: "correctness", severity: "high", file, line, description: "d", recommendation: "r", confidence: 0.8 };
}

test("crossSourceCorroborate: location-based LLM∩tool agreement", () => {
  const llm = [f("src/a.ts", 5), f("src/a.ts", 3), f("src/b.ts", 99)];
  const stat = [f("src/a.ts", 5, "eval"), f("src/a.ts", 40, "far")];
  const r = crossSourceCorroborate(llm, stat, 2);
  assert.deepEqual(r.corroborated.map((x) => x.line), [5, 3]); // 5 exact, 3 within ±2 of 5
  assert.deepEqual(r.llmOnly.map((x) => x.file), ["src/b.ts"]);
  assert.deepEqual(r.staticOnly.map((x) => x.line), [40]);
});
