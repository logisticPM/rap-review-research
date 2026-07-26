import { test } from "node:test";
import assert from "node:assert/strict";

import { ManagerAgent } from "../../src/architectures/hierarchical/manager-agent.ts";
import { DefaultReviewPlanner } from "../../src/architectures/hierarchical/review-plan.ts";
import { Synthesizer } from "../../src/architectures/hierarchical/synthesizer.ts";
import type { IReviewSpecialist } from "../../src/architectures/hierarchical/specialists/review-specialist.ts";
import type { AgentRole } from "../../src/architectures/hierarchical/messages.ts";
import type { SpecialistReviewResult } from "../../src/architectures/hierarchical/models/specialist-review-result.ts";
import type { ReviewFinding } from "../../src/models/finding.ts";
import type { ReviewExecutionInput } from "../../src/models/review-result.ts";
import { WorkflowError } from "../../src/shared/errors.ts";
import { FixedClock } from "../../src/shared/clock.ts";
import { buildSnapshot } from "./support/fixtures.ts";
import { buildFinding } from "./support/stored-results.ts";

/** A network-free specialist for exercising the Manager. */
function fakeSpecialist(
  role: AgentRole,
  findings: ReviewFinding[],
  onReview?: () => void,
): IReviewSpecialist {
  return {
    role,
    async review(): Promise<SpecialistReviewResult> {
      onReview?.();
      return {
        role,
        summary: `${role} summary`,
        findings,
        latencyMs: 10,
        inputTokens: 5,
        outputTokens: 3,
        estimatedCostUsd: 0.001,
      };
    },
  };
}

function input(): ReviewExecutionInput {
  return {
    experimentId: "snap_1#hierarchical#m#v1#w1#e1",
    snapshot: buildSnapshot(),
    modelVersion: "m",
    promptVersion: "v1",
    workflowVersion: "w1",
  };
}

function manager(specialists: IReviewSpecialist[]): ManagerAgent {
  return new ManagerAgent({
    specialists,
    planner: new DefaultReviewPlanner(specialists.map((s) => s.role)),
    synthesizer: new Synthesizer(),
    clock: new FixedClock(),
  });
}

test("runs the deterministic state machine to completion", async () => {
  const m = manager([
    fakeSpecialist("backend", [buildFinding({ id: "b1", file: "a.ts", line: 1, title: "A" })]),
    fakeSpecialist("frontend", [buildFinding({ id: "f1", file: "b.tsx", line: 2, title: "B" })]),
    fakeSpecialist("database", [buildFinding({ id: "d1", file: "c.sql", line: 3, title: "C" })]),
  ]);
  const run = await m.run(input());

  assert.deepEqual(m.states, [
    "created",
    "planning",
    "dispatching",
    "collecting",
    "synthesizing",
    "completed",
  ]);
  assert.equal(run.metrics.specialistCount, 3);
  assert.equal(run.metrics.llmCalls, 3);
  assert.equal(run.result.mergedFindings.length, 3);
});

test("critical-path latency is the slowest specialist, not the sum (B3)", async () => {
  const latSpecialist = (role: AgentRole, latencyMs: number): IReviewSpecialist => ({
    role,
    async review(): Promise<SpecialistReviewResult> {
      return { role, summary: "", findings: [], latencyMs, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 };
    },
  });
  const m = manager([
    latSpecialist("backend", 100),
    latSpecialist("frontend", 40),
    latSpecialist("database", 10),
  ]);
  const run = await m.run(input());
  // Sum would be 150; the parallel round's critical path is the slowest (100),
  // plus a 0ms merge under FixedClock.
  assert.equal(run.metrics.criticalPathLatencyMs, 100);
});

test("dispatches each specialist exactly once and records typed messages", async () => {
  let backendCalls = 0;
  const m = manager([
    fakeSpecialist("backend", [buildFinding({ id: "b1" })], () => (backendCalls += 1)),
    fakeSpecialist("frontend", []),
    fakeSpecialist("database", []),
  ]);
  const run = await m.run(input());

  assert.equal(backendCalls, 1);
  // 2 messages per specialist (request+response) + 2 merge messages.
  assert.equal(run.conversation.messages.length, 8);
  assert.equal(run.metrics.messageCount, 8);

  const first = run.conversation.messages[0];
  assert.equal(first?.from, "manager");
  assert.equal(first?.to, "backend");
  assert.equal(first?.type, "review-request");
  assert.ok(run.conversation.messages.some((msg) => msg.type === "merge-response"));
});

test("creates a plan covering all registered specialists", async () => {
  const planner = new DefaultReviewPlanner(["backend", "frontend", "database"]);
  const plan = planner.createPlan(input());
  assert.equal(plan.experimentId, "snap_1#hierarchical#m#v1#w1#e1");
  assert.deepEqual(plan.specialists, ["backend", "frontend", "database"]);
});

test("fails fast when a specialist throws (state → failed, error propagates)", async () => {
  const failing: IReviewSpecialist = {
    role: "backend",
    async review(): Promise<SpecialistReviewResult> {
      throw new WorkflowError("specialist boom");
    },
  };
  const m = manager([failing]);
  await assert.rejects(() => m.run(input()), WorkflowError);
  assert.equal(m.states[m.states.length - 1], "failed");
});
