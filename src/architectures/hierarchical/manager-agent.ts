import type { ReviewExecutionInput } from "../../models/review-result.ts";
import type { Clock } from "../../shared/clock.ts";
import type { Logger } from "../../shared/logger.ts";
import type { AgentRole, AgentMessageType } from "./messages.ts";
import type { IReviewSpecialist } from "./specialists/review-specialist.ts";
import type { IReviewPlanner, ReviewPlan } from "./review-plan.ts";
import type { SpecialistReviewResult } from "./models/specialist-review-result.ts";
import type { HierarchicalReviewResult } from "./models/hierarchical-review-result.ts";
import type { HierarchicalMetrics } from "./models/hierarchical-metrics.ts";

import { NoopLogger } from "../../shared/logger.ts";
import { WorkflowError } from "../../shared/errors.ts";
import { ConversationHistory } from "./conversation-history.ts";
import { Synthesizer } from "./synthesizer.ts";

/** Deterministic states of the Manager's workflow. */
export type ManagerState =
  | "created"
  | "planning"
  | "dispatching"
  | "collecting"
  | "synthesizing"
  | "completed"
  | "failed";

export interface ManagerAgentDependencies {
  readonly specialists: IReviewSpecialist[];
  readonly planner: IReviewPlanner;
  readonly synthesizer: Synthesizer;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface ManagerRunResult {
  readonly plan: ReviewPlan;
  readonly result: HierarchicalReviewResult;
  readonly metrics: HierarchicalMetrics;
  readonly conversation: ConversationHistory;
}

/**
 * The coordinator of the hierarchical topology, implemented as a deterministic
 * state machine (created → planning → dispatching → collecting → synthesizing →
 * completed; any failure → failed). One Manager instance runs one review.
 *
 * The Manager depends only on `IReviewSpecialist[]` (plugins) and `IReviewPlanner`
 * — never on concrete reviewer classes. It never calls Bedrock; specialists own
 * their own LLM calls. No retries, no partial completion (fail fast).
 */
export class ManagerAgent {
  public readonly conversation = new ConversationHistory();

  private readonly specialists: IReviewSpecialist[];
  private readonly planner: IReviewPlanner;
  private readonly synthesizer: Synthesizer;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly stateLog: ManagerState[] = ["created"];

  public constructor(deps: ManagerAgentDependencies) {
    this.specialists = deps.specialists;
    this.planner = deps.planner;
    this.synthesizer = deps.synthesizer;
    this.clock = deps.clock;
    this.logger = deps.logger ?? new NoopLogger();
  }

  /** Observed state transitions (testing/inspection). */
  public get states(): ManagerState[] {
    return [...this.stateLog];
  }

  public async run(input: ReviewExecutionInput): Promise<ManagerRunResult> {
    try {
      this.transition("planning");
      const plan = this.planner.createPlan(input);

      this.transition("dispatching");
      const specialistResults = await this.dispatch(plan, input);

      this.transition("collecting");
      // Findings are now collected on `specialistResults`.

      this.transition("synthesizing");
      const mergeStart = Date.parse(this.clock.nowIso());
      this.send("manager", "manager", "merge-request", {
        specialistCount: specialistResults.length,
      });
      const result = this.synthesizer.synthesize(specialistResults);
      this.send("manager", "manager", "merge-response", {
        mergedFindings: result.mergedFindings.length,
        duplicateCount: result.duplicateCount,
      });
      const mergeLatencyMs = Date.parse(this.clock.nowIso()) - mergeStart;

      this.transition("completed");

      const maxSpecialistLatencyMs = specialistResults.reduce(
        (max, r) => Math.max(max, r.latencyMs),
        0,
      );
      const metrics: HierarchicalMetrics = {
        specialistCount: specialistResults.length,
        llmCalls: specialistResults.length,
        messageCount: this.conversation.messages.length,
        duplicateCount: result.duplicateCount,
        mergeLatencyMs,
        // One parallel round: slowest specialist + the deterministic merge.
        criticalPathLatencyMs: maxSpecialistLatencyMs + mergeLatencyMs,
      };
      return { plan, result, metrics, conversation: this.conversation };
    } catch (error) {
      this.transition("failed");
      throw error;
    }
  }

  private async dispatch(
    plan: ReviewPlan,
    input: ReviewExecutionInput,
  ): Promise<SpecialistReviewResult[]> {
    // Specialists review the same input independently, so dispatch them in
    // parallel: the topology has no data dependency between them. Request
    // messages are recorded first and responses after (in plan order) so the
    // conversation stays deterministic and messageCount is unchanged.
    for (const role of plan.specialists) {
      this.send("manager", role, "review-request", {
        snapshotId: input.snapshot.snapshotId,
      });
    }
    const results = await Promise.all(
      plan.specialists.map((role) => this.specialistFor(role).review(input)),
    );
    plan.specialists.forEach((role, i) => {
      this.send(role, "manager", "review-response", {
        findingCount: (results[i] as SpecialistReviewResult).findings.length,
      });
    });
    return results;
  }

  private specialistFor(role: AgentRole): IReviewSpecialist {
    const specialist = this.specialists.find((s) => s.role === role);
    if (!specialist) {
      throw new WorkflowError(
        `No specialist registered for role "${role}".`,
      );
    }
    return specialist;
  }

  private transition(state: ManagerState): void {
    this.stateLog.push(state);
    this.logger.info(`Manager → ${state}`, { architecture: "hierarchical" });
  }

  private send(
    from: AgentRole,
    to: AgentRole,
    type: AgentMessageType,
    content: unknown,
  ): void {
    this.conversation.record({
      from,
      to,
      type,
      content,
      timestamp: this.clock.nowIso(),
    });
  }
}
