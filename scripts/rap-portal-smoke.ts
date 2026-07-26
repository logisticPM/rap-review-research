/**
 * LIVE RAP Portal case-study smoke test against real Bedrock (Experiment E3).
 *
 * Run with: `npm run smoke:rap` (optionally `RAP_PR=101 RAP_PRS=101,99`).
 *
 * The RAP Portal is the industrial case study (docs/experiments/02 §6). Unlike
 * Qodo / SWE-PRBench it is NOT a benchmark dataset: it has no authoritative
 * ground truth, so this script makes NO correctness claims (no precision /
 * recall / F1). It proves the pipeline runs end-to-end on real PRs and reports
 * industrial-verification signals by corroboration: cross-architecture agreement
 * and independent LLM-judge validation, alongside cost/latency/communication.
 *
 * PRs are pulled live from GitHub with the `gh` CLI (you must be `gh auth`'d and
 * have read access to the repo). Nothing is downloaded to disk.
 *
 * Preconditions: `aws sso login` + Bedrock model access (smoke:bedrock first),
 * and `gh auth status` for github.com/logisticPM/portal.
 */
import { execFileSync } from "node:child_process";

import { createPRImportService } from "../src/services/snapshot/index.ts";
import { createExperimentService } from "../src/services/experiment/index.ts";
import { InMemorySnapshotRepository } from "../src/repositories/in-memory/in-memory-snapshot-repository.ts";
import { InMemoryRawDiffStorage } from "../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { InMemoryArchitectureRegistry } from "../src/architectures/in-memory-architecture-registry.ts";
import { AgentlessArchitecture } from "../src/architectures/agentless/agentless-architecture.ts";
import { createHierarchicalArchitecture } from "../src/architectures/hierarchical/index.ts";
import { createConsensusArchitecture } from "../src/architectures/consensus/index.ts";
import { PromptBuilder } from "../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../src/llm/prompts/context-builder.ts";
import { BedrockProvider } from "../src/llm/provider/bedrock-provider.ts";
import { LLM_CONFIG } from "../src/config/llm.ts";
import type { ReviewArchitecture } from "../src/models/experiment.ts";
import { EvaluationEngine, LlmJudgeValidationCalculator } from "../src/evaluation/index.ts";
import type { FindingVerdict } from "../src/evaluation/index.ts";
import type { StoredExperimentResult } from "../src/storage/stored-models.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import type { LLMReviewRequest } from "../src/llm/models/llm-review-request.ts";

const REPO = process.env.RAP_REPO ?? "logisticPM/portal";
// One PR by default (a true smoke test); RAP_PRS overrides with a CSV list.
const PR_NUMBERS = (process.env.RAP_PRS ?? process.env.RAP_PR ?? "101")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ARCHITECTURES: ReviewArchitecture[] = [
  "agentless",
  "hierarchical",
  "consensus",
];

/** Read a merged/open PR's title + unified diff straight from GitHub. */
function fetchPR(pr: string): { title: string; diff: string } {
  const title = execFileSync(
    "gh",
    ["pr", "view", pr, "-R", REPO, "--json", "title", "-q", ".title"],
    { encoding: "utf8" },
  ).trim();
  const diff = execFileSync("gh", ["pr", "diff", pr, "-R", REPO], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { title, diff };
}

const VERDICTS: readonly FindingVerdict[] = ["valid", "invalid", "uncertain"];

/**
 * Independent LLM-judge validation: a separate Bedrock call — distinct from the
 * reviewer architectures — classifies each finding as valid/invalid/uncertain
 * given the diff. This is the producer for `llmJudgeValidation`, a supporting
 * corroboration signal, NOT ground truth. Judged per architecture so finding ids
 * never collide. Non-fatal on error (returns no verdicts).
 */
async function judgeFindings(
  diff: string,
  findings: ReviewFinding[],
): Promise<Record<string, FindingVerdict>> {
  if (findings.length === 0) {
    return {};
  }
  const list = findings
    .map((f) => `- ${f.id} [${f.severity}] ${f.file}:${f.line} — ${f.title}: ${f.description}`)
    .join("\n");
  const request: LLMReviewRequest = {
    systemPrompt:
      "You are an impartial senior engineer acting as a JUDGE. You did not write these findings. " +
      "For each finding, decide — based only on the diff — whether it is a genuine issue. " +
      'Respond with a single JSON object mapping each finding id to "valid", "invalid", or "uncertain". No prose.',
    userPrompt: `## Diff\n\n${diff}\n\n## Findings to judge\n\n${list}\n\n## Respond with JSON only\n\n{ "<id>": "valid | invalid | uncertain" }`,
    modelId: LLM_CONFIG.defaultModel,
    temperature: 0,
    maxTokens: 1024,
  };
  try {
    const response = await provider.review(request);
    return parseVerdicts(response.text, findings);
  } catch {
    return {};
  }
}

/** Tolerant parse of the judge's JSON into verdicts for known finding ids. */
function parseVerdicts(
  text: string,
  findings: ReviewFinding[],
): Record<string, FindingVerdict> {
  const ids = new Set(findings.map((f) => f.id));
  const out: Record<string, FindingVerdict> = {};
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end < start) {
      return out;
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    for (const [id, raw] of Object.entries(parsed)) {
      const v = typeof raw === "string" ? (raw.toLowerCase() as FindingVerdict) : undefined;
      if (v && ids.has(id) && VERDICTS.includes(v)) {
        out[id] = v;
      }
    }
  } catch {
    // tolerant: unparseable judge output yields no verdicts
  }
  return out;
}

// Real Bedrock provider (default AWS credential chain) shared by all three
// architectures — only the communication topology differs (fairness policy).
const provider = new BedrockProvider();
const promptBuilder = new PromptBuilder({
  loader: new PromptLoader(),
  contextBuilder: new ContextBuilder(),
});
const snapshots = new InMemorySnapshotRepository();
const rawDiffStorage = new InMemoryRawDiffStorage();

const registry = new InMemoryArchitectureRegistry();
registry.register(new AgentlessArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createHierarchicalArchitecture({ provider, promptBuilder, rawDiffStorage }));
registry.register(createConsensusArchitecture({ provider, promptBuilder, rawDiffStorage }));

const importCtx = createPRImportService({ snapshots, rawDiffStorage });
const experimentCtx = createExperimentService({ snapshots, registry });
const evaluation = new EvaluationEngine();

console.log(`LIVE RAP Portal case study — Bedrock ${LLM_CONFIG.defaultModel} @ ${LLM_CONFIG.region}`);
console.log(`  repo: github.com/${REPO}   PRs: ${PR_NUMBERS.join(", ")}`);
console.log(`  NOTE: no ground truth — industrial verification via corroboration`);
console.log(`  (cross-architecture agreement + LLM-judge validation; NOT precision/recall)\n`);

let failures = 0;

for (const pr of PR_NUMBERS) {
  let title: string;
  let diff: string;
  try {
    ({ title, diff } = fetchPR(pr));
  } catch (error) {
    failures += 1;
    console.error(`PR #${pr}  ✗ could not fetch from GitHub: ${errMsg(error)}`);
    console.error(`  hint: run \`gh auth status\` and confirm read access to ${REPO}\n`);
    continue;
  }

  if (diff.trim().length === 0) {
    console.log(`PR #${pr} "${title}"  — empty diff, skipped\n`);
    continue;
  }

  const { snapshotId } = await importCtx.service.importManualDiff({
    title: `[RAP Portal] #${pr} ${title}`,
    source: "manual",
    rawDiff: diff,
  });

  console.log(`PR #${pr} "${title}"  (snapshot ${snapshotId}, ${diff.split("\n").length} diff lines)`);

  const results: StoredExperimentResult[] = [];
  for (const architecture of ARCHITECTURES) {
    try {
      const run = await experimentCtx.service.runExperiment({
        snapshotId,
        architecture,
        modelVersion: LLM_CONFIG.defaultModel,
        promptVersion: "v1",
        workflowVersion: "workflow-v1",
        evaluationVersion: "eval-v1",
      });
      const stored = await experimentCtx.storage.getExperimentResult(run.experimentId);
      if (stored) {
        results.push(stored);
      }
      const v = stored?.validatedResult;
      const findings = v?.findings.length ?? stored?.findings.length ?? 0;
      const cost = v?.estimatedCostUsd ?? 0;
      const latency = v?.latencyMs ?? 0;
      const tokens = v ? `${v.inputTokens}/${v.outputTokens}` : "n/a";
      console.log(
        `  ${architecture.padEnd(12)} ✓ findings=${findings} ` +
          `latency=${latency}ms tokens=${tokens} ` +
          `cost=$${cost.toFixed(6)} llmCalls=${v?.llmCalls ?? "?"} msgs=${v?.messageCount ?? "?"}`,
      );
    } catch (error) {
      failures += 1;
      console.error(`  ${architecture.padEnd(12)} ✗ ${errMsg(error)}`);
    }
  }

  // Industrial verification (no ground truth): cross-architecture agreement
  // (needs no external data) plus an independent LLM judge per architecture.
  // Static-analysis agreement is left n/a here — running a static analyzer on an
  // arbitrary PR is out of scope for a smoke test (its collector is follow-up).
  const verified = evaluation.evaluateIndustrial(results);
  const judge = new LlmJudgeValidationCalculator();
  console.log(`  — industrial verification —`);
  for (const m of verified) {
    const findings =
      results.find((r) => r.validatedResult?.architecture === m.architecture)
        ?.validatedResult?.findings ?? [];
    const verdicts = await judgeFindings(diff, findings);
    const judgeRate = findings.length > 0 ? judge.calculate(findings, verdicts) : undefined;
    console.log(
      `    ${m.architecture.padEnd(12)} agreement=${fmtRate(m.researchEvidence.architectureAgreement)} ` +
        `judgeValid=${fmtRate(judgeRate)} staticAgreement=n/a ` +
        `evidence(heuristic)=${m.researchEvidence.evidenceScore.toFixed(2)}`,
    );
  }
  console.log();
}

if (failures > 0) {
  process.exitCode = 1;
  console.log(`Completed with ${failures} failure(s).`);
} else {
  console.log("RAP Portal smoke test SUCCESS ✓ — pipeline ran end-to-end on real PRs.");
}

function errMsg(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Render an optional rate in [0,1] as a percentage, or "n/a" when not computable. */
function fmtRate(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}
