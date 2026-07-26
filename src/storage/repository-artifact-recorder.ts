import type { HierarchicalReviewResult } from "../architectures/hierarchical/models/hierarchical-review-result.ts";
import type { ConsensusReviewResult } from "../architectures/consensus/models/consensus-review-result.ts";
import type { Clock } from "../shared/clock.ts";
import type { ArtifactRepository } from "./artifact-repository.ts";
import type { ReviewArtifactRecorder } from "./review-artifact-recorder.ts";

import { SystemClock } from "../shared/clock.ts";

/**
 * A {@link ReviewArtifactRecorder} that persists intermediate artifacts through
 * an {@link ArtifactRepository}, stamping each with `storedAt`. Pure adapter —
 * no serialization logic beyond wrapping the result.
 */
export class RepositoryArtifactRecorder implements ReviewArtifactRecorder {
  private readonly repository: ArtifactRepository;
  private readonly clock: Clock;

  public constructor(repository: ArtifactRepository, clock: Clock = new SystemClock()) {
    this.repository = repository;
    this.clock = clock;
  }

  public async recordHierarchical(
    experimentId: string,
    result: HierarchicalReviewResult,
  ): Promise<void> {
    await this.repository.save({
      experimentId,
      architecture: "hierarchical",
      storedAt: this.clock.nowIso(),
      hierarchical: result,
    });
  }

  public async recordConsensus(
    experimentId: string,
    result: ConsensusReviewResult,
  ): Promise<void> {
    await this.repository.save({
      experimentId,
      architecture: "consensus",
      storedAt: this.clock.nowIso(),
      consensus: result,
    });
  }
}
