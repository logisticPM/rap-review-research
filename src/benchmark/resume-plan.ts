import type { BenchmarkRun } from "./models/benchmark-run.ts";

/**
 * Instance-level resume of a benchmark chunk (Phase 2 budget saver).
 *
 * A confirmatory chunk is a fixed set of instances, each reviewed by every
 * architecture for a fixed number of runs. A failed `(instance, arch, run)`
 * tuple leaves NO {@link BenchmarkRun} behind (the executor returns null on
 * failure), so an instance is **complete** iff its persisted run count reaches
 * `expectedPerInstance` (= architectures × runsPerInstance). On a resumed run we
 * regenerate ONLY incomplete instances and carry the complete ones verbatim —
 * the budget win when a daily-token cap fails whole instances mid-chunk.
 *
 * This is byte-neutral to the frozen generation config: a regenerated instance
 * is produced by the identical model / prompt / temperature / architecture /
 * runs, merely supplying fresh independent samples for the runs that never
 * landed. It changes WHICH instances are (re)generated, not HOW — the same
 * standing as the `RUNS_PER_INSTANCE` conformance knob, and it does not touch
 * the double-freeze line.
 */
export interface InstanceResumePlan {
  /** Runs to keep as-is: every run belonging to an already-complete instance. */
  readonly carriedRuns: BenchmarkRun[];
  /** Intended instance ids still needing (re)generation (missing ≥1 run). */
  readonly instanceIdsToRun: string[];
  /** Intended instance ids already complete (skipped — the budget win). */
  readonly completeInstanceIds: string[];
}

/**
 * Partition the intended instances of a chunk into complete (carry) vs.
 * incomplete (regenerate), given the runs persisted by prior attempts.
 *
 * @param priorRuns runs persisted by earlier attempts at this chunk
 * @param intendedInstanceIds the chunk's full instance set (incl. ones with zero
 *   persisted runs — e.g. instances that never ran before the cap hit)
 * @param expectedPerInstance runs expected per complete instance
 *   (architectures × runsPerInstance)
 */
export function planInstanceResume(
  priorRuns: readonly BenchmarkRun[],
  intendedInstanceIds: readonly string[],
  expectedPerInstance: number,
): InstanceResumePlan {
  const expected = Math.max(1, expectedPerInstance);

  const countById = new Map<string, number>();
  for (const run of priorRuns) {
    countById.set(run.instanceId, (countById.get(run.instanceId) ?? 0) + 1);
  }

  const completeInstanceIds: string[] = [];
  const instanceIdsToRun: string[] = [];
  for (const id of intendedInstanceIds) {
    if ((countById.get(id) ?? 0) >= expected) {
      completeInstanceIds.push(id);
    } else {
      instanceIdsToRun.push(id);
    }
  }

  // Carry runs only for complete instances (⊆ intended). Runs for instances
  // being regenerated are dropped (they'll be replaced by fresh runs); runs for
  // instances no longer in the chunk (stale) are dropped too.
  const complete = new Set(completeInstanceIds);
  const carriedRuns = priorRuns.filter((run) => complete.has(run.instanceId));

  return { carriedRuns, instanceIdsToRun, completeInstanceIds };
}
