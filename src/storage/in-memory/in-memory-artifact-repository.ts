import type { StoredReviewArtifact } from "../stored-artifacts.ts";
import type { ArtifactRepository } from "../artifact-repository.ts";
import { DuplicateArtifactError } from "../storage-errors.ts";

/**
 * In-memory {@link ArtifactRepository}.
 *
 * Stores one immutable intermediate artifact per experiment. Values are
 * deep-cloned on write and read so stored artifacts are never affected by later
 * caller mutations, and vice versa.
 */
export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly byExperimentId = new Map<string, StoredReviewArtifact>();

  public async save(artifact: StoredReviewArtifact): Promise<void> {
    if (this.byExperimentId.has(artifact.experimentId)) {
      throw new DuplicateArtifactError(
        `Artifact already stored for experiment "${artifact.experimentId}".`,
      );
    }
    this.byExperimentId.set(artifact.experimentId, structuredClone(artifact));
  }

  public async getByExperimentId(
    experimentId: string,
  ): Promise<StoredReviewArtifact | null> {
    const found = this.byExperimentId.get(experimentId);
    return found ? structuredClone(found) : null;
  }
}
