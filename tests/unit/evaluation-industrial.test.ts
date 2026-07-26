import { test } from "node:test";
import assert from "node:assert/strict";

import { EvaluationEngine } from "../../src/evaluation/evaluation-engine.ts";
import {
  FindingSimilarity,
  ArchitectureAgreementCalculator,
  StaticAnalysisAgreementCalculator,
  LlmJudgeValidationCalculator,
  LaterFixRateCalculator,
  IndustrialVerification,
} from "../../src/evaluation/industrial/index.ts";
import type { FindingVerdict } from "../../src/evaluation/industrial/index.ts";
import { buildStoredResult, buildFinding } from "./support/stored-results.ts";

// ---------------------------------------------------------------------------
// FindingSimilarity
// ---------------------------------------------------------------------------

test("FindingSimilarity: same file, near line, same category → agree", () => {
  const sim = new FindingSimilarity();
  const a = buildFinding({ file: "src/a.ts", line: 10, category: "security" });
  const b = buildFinding({ file: "src/a.ts", line: 11, category: "security", title: "totally different words" });
  assert.equal(sim.agree(a, b), true);
});

test("FindingSimilarity: different file → never agree", () => {
  const sim = new FindingSimilarity();
  const a = buildFinding({ file: "src/a.ts", line: 10 });
  const b = buildFinding({ file: "src/b.ts", line: 10 });
  assert.equal(sim.agree(a, b), false);
});

test("FindingSimilarity: same spot, different category but similar title → agree", () => {
  const sim = new FindingSimilarity();
  const a = buildFinding({ file: "src/a.ts", line: 10, category: "security", title: "Unvalidated query parameter" });
  const b = buildFinding({ file: "src/a.ts", line: 10, category: "correctness", title: "Unvalidated query parameter here" });
  assert.equal(sim.agree(a, b), true);
});

test("FindingSimilarity: same spot, different category and unrelated title → disagree", () => {
  const sim = new FindingSimilarity();
  const a = buildFinding({ file: "src/a.ts", line: 10, category: "security", title: "SQL injection risk" });
  const b = buildFinding({ file: "src/a.ts", line: 10, category: "performance", title: "Unbounded loop allocation" });
  assert.equal(sim.agree(a, b), false);
});

// ---------------------------------------------------------------------------
// ArchitectureAgreementCalculator
// ---------------------------------------------------------------------------

test("agreement: a finding seen by two architectures counts for both", () => {
  const calc = new ArchitectureAgreementCalculator();
  const shared = { file: "src/a.ts", line: 5, category: "security" };
  const result = calc.calculate([
    { architecture: "agentless", findings: [buildFinding({ id: "a1", ...shared })] },
    { architecture: "consensus", findings: [buildFinding({ id: "c1", ...shared })] },
  ]);
  assert.equal(result.byArchitecture.get("agentless"), 1);
  assert.equal(result.byArchitecture.get("consensus"), 1);
  assert.equal(result.corroboratedFindingCount, 2);
});

test("agreement: solo findings score 0 for that architecture", () => {
  const calc = new ArchitectureAgreementCalculator();
  const result = calc.calculate([
    {
      architecture: "agentless",
      findings: [
        buildFinding({ id: "a1", file: "src/a.ts", line: 5, category: "security" }),
        buildFinding({ id: "a2", file: "src/z.ts", line: 99, category: "performance" }),
      ],
    },
    { architecture: "consensus", findings: [buildFinding({ id: "c1", file: "src/a.ts", line: 5, category: "security" })] },
  ]);
  assert.equal(result.byArchitecture.get("agentless"), 0.5); // 1 of 2 corroborated
  assert.equal(result.byArchitecture.get("consensus"), 1);
});

test("agreement: undefined with a single architecture or no findings", () => {
  const calc = new ArchitectureAgreementCalculator();
  const single = calc.calculate([{ architecture: "agentless", findings: [buildFinding()] }]);
  assert.equal(single.byArchitecture.get("agentless"), undefined);

  const empty = calc.calculate([
    { architecture: "agentless", findings: [] },
    { architecture: "consensus", findings: [buildFinding()] },
  ]);
  assert.equal(empty.byArchitecture.get("agentless"), undefined); // no findings → not computable
});

// ---------------------------------------------------------------------------
// StaticAnalysisAgreementCalculator
// ---------------------------------------------------------------------------

test("staticAnalysisAgreement: fraction of findings near a static-analysis issue", () => {
  const calc = new StaticAnalysisAgreementCalculator();
  const findings = [
    buildFinding({ id: "f1", file: "src/a.ts", line: 10 }),
    buildFinding({ id: "f2", file: "src/a.ts", line: 200 }),
  ];
  const rate = calc.calculate(findings, [{ file: "src/a.ts", line: 11, rule: "no-unsafe" }]);
  assert.equal(rate, 0.5);
});

test("staticAnalysisAgreement: category must match when the tool reports one", () => {
  const calc = new StaticAnalysisAgreementCalculator();
  const finding = buildFinding({ file: "src/a.ts", line: 10, category: "security" });
  assert.equal(calc.calculate([finding], [{ file: "src/a.ts", line: 10, category: "performance" }]), 0);
  assert.equal(calc.calculate([finding], [{ file: "src/a.ts", line: 10, category: "security" }]), 1);
});

test("staticAnalysisAgreement: 0 when there are no findings (never NaN)", () => {
  const calc = new StaticAnalysisAgreementCalculator();
  assert.equal(calc.calculate([], [{ file: "src/a.ts", line: 1 }]), 0);
});

// ---------------------------------------------------------------------------
// LlmJudgeValidationCalculator
// ---------------------------------------------------------------------------

test("llmJudgeValidation: fraction judged valid; invalid/uncertain/unjudged excluded", () => {
  const calc = new LlmJudgeValidationCalculator();
  const findings = [
    buildFinding({ id: "f1" }),
    buildFinding({ id: "f2" }),
    buildFinding({ id: "f3" }),
    buildFinding({ id: "f4" }),
  ];
  const verdicts: Record<string, FindingVerdict> = {
    f1: "valid",
    f2: "invalid",
    f3: "uncertain",
    // f4 unjudged
  };
  assert.equal(calc.calculate(findings, verdicts), 0.25);
});

test("llmJudgeValidation: 0 when there are no findings", () => {
  const calc = new LlmJudgeValidationCalculator();
  assert.equal(calc.calculate([], { x: "valid" }), 0);
});

// ---------------------------------------------------------------------------
// LaterFixRateCalculator
// ---------------------------------------------------------------------------

test("laterFixRate: findings whose line was later changed", () => {
  const calc = new LaterFixRateCalculator();
  const findings = [
    buildFinding({ id: "f1", file: "src/a.ts", line: 10 }),
    buildFinding({ id: "f2", file: "src/a.ts", line: 500 }),
  ];
  const rate = calc.calculate(findings, [{ file: "src/a.ts", lineStart: 8, lineEnd: 20 }]);
  assert.equal(rate, 0.5);
});

// ---------------------------------------------------------------------------
// IndustrialVerification facade
// ---------------------------------------------------------------------------

test("IndustrialVerification only sets signals that are computable", () => {
  const verifier = new IndustrialVerification();
  const shared = { file: "src/a.ts", line: 5, category: "security" };
  const signals = verifier.verify(
    [
      { architecture: "agentless", findings: [buildFinding({ id: "a1", ...shared })] },
      { architecture: "consensus", findings: [buildFinding({ id: "c1", ...shared })] },
    ],
    {
      staticAnalysisFindings: [{ file: "src/a.ts", line: 5, category: "security" }],
      judgeVerdicts: { a1: "valid", c1: "invalid" },
      // no laterChanges → laterFixRate must stay undefined
    },
  );
  const agentless = signals.get("agentless")!;
  assert.equal(agentless.architectureAgreement, 1);
  assert.equal(agentless.staticAnalysisAgreement, 1);
  assert.equal(agentless.llmJudgeValidation, 1); // a1 → valid
  assert.equal(signals.get("consensus")!.llmJudgeValidation, 0); // c1 → invalid
  assert.equal(agentless.laterFixRate, undefined);
});

// ---------------------------------------------------------------------------
// EvaluationEngine integration (additive, backward compatible)
// ---------------------------------------------------------------------------

test("evaluateIndustrial augments researchEvidence without touching base metrics", () => {
  const engine = new EvaluationEngine();
  const shared = { file: "src/a.ts", line: 5, category: "security" };
  const agentless = buildStoredResult({
    experimentId: "snap_1#agentless#m#v1#w1#e1",
    architecture: "agentless",
    findings: [buildFinding({ id: "a1", ...shared })],
  });
  const consensus = buildStoredResult({
    experimentId: "snap_1#consensus#m#v1#w1#e1",
    architecture: "consensus",
    findings: [buildFinding({ id: "c1", ...shared })],
  });

  const base = engine.evaluate(agentless);
  const [augmented] = engine.evaluateIndustrial([agentless, consensus], {
    staticAnalysisFindings: [{ file: "src/a.ts", line: 5, category: "security" }],
    judgeVerdicts: { a1: "valid" },
    laterChanges: [{ file: "src/a.ts", lineStart: 1, lineEnd: 10 }],
  });

  // Base metrics unchanged.
  assert.equal(augmented!.researchEvidence.evidenceScore, base.researchEvidence.evidenceScore);
  assert.equal(augmented!.reviewQuality.findingCount, base.reviewQuality.findingCount);
  // Industrial signals populated.
  assert.equal(augmented!.researchEvidence.architectureAgreement, 1);
  assert.equal(augmented!.researchEvidence.staticAnalysisAgreement, 1);
  assert.equal(augmented!.researchEvidence.llmJudgeValidation, 1);
  assert.equal(augmented!.researchEvidence.laterFixRate, 1);
});

test("evaluate() is unchanged: no industrial signals leak into the base method", () => {
  const engine = new EvaluationEngine();
  const m = engine.evaluate(buildStoredResult({ findings: [buildFinding()] }));
  assert.equal(m.researchEvidence.architectureAgreement, undefined);
  assert.equal(m.researchEvidence.staticAnalysisAgreement, undefined);
  assert.equal(m.researchEvidence.llmJudgeValidation, undefined);
  assert.equal(m.researchEvidence.laterFixRate, undefined);
});

test("evaluateBatchIndustrial populates cross-architecture agreement per PR", () => {
  const engine = new EvaluationEngine();
  const shared = { file: "src/a.ts", line: 5, category: "security" };
  const comparisons = engine.evaluateBatchIndustrial([
    buildStoredResult({ experimentId: "snap_1#agentless#m#v1#w1#e1", architecture: "agentless", findings: [buildFinding({ id: "a1", ...shared })] }),
    buildStoredResult({ experimentId: "snap_1#consensus#m#v1#w1#e1", architecture: "consensus", findings: [buildFinding({ id: "c1", ...shared })] }),
  ]);
  const snap1 = comparisons.find((c) => c.experimentId === "snap_1")!;
  for (const arch of snap1.architectures) {
    assert.equal(arch.researchEvidence.architectureAgreement, 1);
  }
});
