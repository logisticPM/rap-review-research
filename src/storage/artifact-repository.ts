import type { StoredReviewArtifact } from "./stored-artifacts.ts";

/**
 * Persistence port for multi-agent intermediate artifacts (roadmap B1).
 *
 * Artifacts are immutable — saving a second artifact for the same experiment
 * must be rejected, mirroring {@link RawResultRepository}.
 */
export interface ArtifactRepository {
  /**
   * Persist an intermediate artifact.
   * @throws DuplicateArtifactError if one already exists for the experiment.
   */
  save(artifact: StoredReviewArtifact): Promise<void>;

  /** Look up the artifact for an experiment, or `null` if absent. */
  getByExperimentId(
    experimentId: string,
  ): Promise<StoredReviewArtifact | null>;
}
