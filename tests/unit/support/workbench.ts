import type {
  Experiment,
  ReviewArchitecture,
} from "../../../src/models/experiment.ts";
import type { ExperimentMetrics } from "../../../src/evaluation/models/experiment-metrics.ts";
import type { AgentMessage } from "../../../src/architectures/shared/agent.ts";

import { ConversationHistory } from "../../../src/architectures/shared/conversation-history.ts";

/** Build a canonical completed Experiment for Workbench tests. */
export function buildExperiment(
  overrides: Partial<Experiment> = {},
): Experiment {
  return {
    experimentId: "snap_001#agentless#m#v1#w1#e1",
    snapshotId: "snap_001",
    architecture: "agentless",
    modelVersion: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    promptVersion: "v1",
    workflowVersion: "w1",
    evaluationVersion: "e1",
    status: "completed",
    createdAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

/** Build ExperimentMetrics with sensible defaults. */
export function buildMetrics(
  overrides: {
    experimentId?: string;
    architecture?: ReviewArchitecture;
    findingCount?: number;
    evidenceScore?: number;
  } = {},
): ExperimentMetrics {
  return {
    experimentId: overrides.experimentId ?? "snap_001#agentless#m#v1#w1#e1",
    architecture: overrides.architecture ?? "agentless",
    reviewQuality: {
      findingCount: overrides.findingCount ?? 3,
      lowSeverityCount: 1,
      mediumSeverityCount: 1,
      highSeverityCount: 1,
      criticalSeverityCount: 0,
      averageConfidence: 0.75,
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
    },
  };
}

/** Build a ConversationHistory from raw message parts. */
export function buildConversation(
  messages: Array<Partial<AgentMessage>>,
): ConversationHistory {
  const history = new ConversationHistory();
  for (const [i, m] of messages.entries()) {
    history.record({
      from: m.from ?? "coordinator",
      to: m.to ?? "backend",
      type: m.type ?? "review-request",
      content: m.content ?? { note: `msg-${i}` },
      timestamp: m.timestamp ?? `2026-07-02T00:00:0${i}.000Z`,
    });
  }
  return history;
}
