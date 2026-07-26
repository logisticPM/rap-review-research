/**
 * Shared wiring for the benchmark demo scripts (RFC-13).
 *
 * Loads the small sample fixtures through the dataset adapters and builds an
 * import/experiment pipeline backed by a MockProvider — so `npm run benchmark:*`
 * exercises all three architectures with no Bedrock and no network. Real runs
 * would swap the provider and point the loader at a downloaded dataset.
 */
import { readFileSync } from "node:fs";

import { createPRImportService } from "../src/services/snapshot/index.ts";
import { createExperimentService } from "../src/services/experiment/index.ts";
import { InMemorySnapshotRepository } from "../src/repositories/in-memory/in-memory-snapshot-repository.ts";
import { InMemoryRawDiffStorage } from "../src/storage/in-memory/in-memory-raw-diff-storage.ts";
import { InMemoryArtifactRepository } from "../src/storage/in-memory/in-memory-artifact-repository.ts";
import { RepositoryArtifactRecorder } from "../src/storage/repository-artifact-recorder.ts";
import { InMemoryArchitectureRegistry } from "../src/architectures/in-memory-architecture-registry.ts";
import { AgentlessArchitecture } from "../src/architectures/agentless/agentless-architecture.ts";
import { createHierarchicalArchitecture } from "../src/architectures/hierarchical/index.ts";
import { createConsensusArchitecture } from "../src/architectures/consensus/index.ts";
import { createGeneralistsArchitecture } from "../src/architectures/generalists/index.ts";
import { PromptBuilder } from "../src/llm/prompts/prompt-builder.ts";
import { PromptLoader } from "../src/llm/prompts/prompt-loader.ts";
import { ContextBuilder } from "../src/llm/prompts/context-builder.ts";
import { MockProvider } from "../src/llm/provider/mock-provider.ts";
import type { LLMReviewRequest } from "../src/llm/models/llm-review-request.ts";

import {
  QodoPRReviewBenchAdapter,
  SWEPRBenchAdapter,
} from "../src/benchmark/index.ts";
import type {
  BenchmarkDataset,
  BenchmarkExecutionConfig,
} from "../src/benchmark/index.ts";
import type { QodoRawDataset } from "../src/benchmark/adapters/qodo-pr-review-bench-adapter.ts";
import type { SWEPRBenchDataset } from "../src/benchmark/adapters/swe-prbench-adapter.ts";

export const EXECUTION_CONFIG: BenchmarkExecutionConfig = {
  modelVersion: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  promptVersion: "v1",
  workflowVersion: "workflow-v1",
  evaluationVersion: "eval-v1",
};

const REVIEW_JSON = JSON.stringify({
  summary: "Review of the change.",
  riskLevel: "high",
  findings: [
    {
      title: "Unvalidated query parameter",
      severity: "high",
      category: "correctness",
      file: "src/api/users.ts",
      line: 11,
      description: "Query parameter reaches db.query without validation.",
      recommendation: "Validate and sanitize the parameter.",
      confidence: 0.85,
    },
  ],
});

const VOTE_JSON = JSON.stringify({
  votes: [
    { candidateId: "candidate-1", vote: "accept", reason: "agree", confidence: 0.8 },
  ],
});

function responder(request: LLMReviewRequest): { text: string } {
  return request.systemPrompt.includes("voting round")
    ? { text: VOTE_JSON }
    : { text: REVIEW_JSON };
}

/** Load and adapt the two sample fixtures into benchmark datasets. */
export function loadSampleDatasets(): {
  qodo: BenchmarkDataset;
  swe: BenchmarkDataset;
} {
  const qodoRaw = JSON.parse(
    readFileSync(
      new URL("../tests/fixtures/benchmark/qodo-sample.json", import.meta.url),
      "utf8",
    ),
  ) as QodoRawDataset;
  const sweRaw = JSON.parse(
    readFileSync(
      new URL("../tests/fixtures/benchmark/swe-sample.json", import.meta.url),
      "utf8",
    ),
  ) as SWEPRBenchDataset;

  return {
    qodo: new QodoPRReviewBenchAdapter().toDataset(qodoRaw),
    swe: new SWEPRBenchAdapter().toDataset(sweRaw),
  };
}

/** Build an import + experiment pipeline with all three architectures (mock). */
export function buildBenchmarkPipeline() {
  const snapshots = new InMemorySnapshotRepository();
  const rawDiffStorage = new InMemoryRawDiffStorage();
  const promptBuilder = new PromptBuilder({
    loader: new PromptLoader(),
    contextBuilder: new ContextBuilder(),
  });
  const provider = new MockProvider({ responder });

  // Persist multi-agent intermediates so the deterministic synthesis is
  // replayable offline (B1). Single-agent (agentless) runs produce none.
  const artifacts = new InMemoryArtifactRepository();
  const artifactRecorder = new RepositoryArtifactRecorder(artifacts);

  const registry = new InMemoryArchitectureRegistry();
  registry.register(
    new AgentlessArchitecture({ provider, promptBuilder, rawDiffStorage }),
  );
  registry.register(
    createHierarchicalArchitecture({
      provider,
      promptBuilder,
      rawDiffStorage,
      artifactRecorder,
    }),
  );
  registry.register(
    createConsensusArchitecture({
      provider,
      promptBuilder,
      rawDiffStorage,
      artifactRecorder,
    }),
  );
  registry.register(
    createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }),
  );

  const importCtx = createPRImportService({ snapshots, rawDiffStorage });
  const experimentCtx = createExperimentService({ snapshots, registry });

  return {
    importService: importCtx.service,
    experimentService: experimentCtx.service,
    storage: experimentCtx.storage,
    artifacts,
  };
}
