/**
 * Public barrel for the storage layer.
 */

// Large-object artifact storage (RFC-03.5).
export type { RawDiffStorage } from "./raw-diff-storage.ts";
export { InMemoryRawDiffStorage } from "./in-memory/in-memory-raw-diff-storage.ts";

// Experiment-result storage (RFC-06).
export type {
  IStorageEngine,
  StorageEngineDependencies,
  StoreRawResultInput,
  StoreValidatedResultInput,
} from "./storage-engine.ts";
export { StorageEngine } from "./storage-engine.ts";

export type { RawResultRepository } from "./raw-result-repository.ts";
export type { ValidatedResultRepository } from "./validated-result-repository.ts";
export type { FindingRepository } from "./finding-repository.ts";
export type { ArtifactRepository } from "./artifact-repository.ts";

export { InMemoryRawResultRepository } from "./in-memory/in-memory-raw-result-repository.ts";
export { InMemoryValidatedResultRepository } from "./in-memory/in-memory-validated-result-repository.ts";
export { InMemoryFindingRepository } from "./in-memory/in-memory-finding-repository.ts";
export { InMemoryArtifactRepository } from "./in-memory/in-memory-artifact-repository.ts";

// Intermediate-artifact persistence for replay (B1).
export type { ReviewArtifactRecorder } from "./review-artifact-recorder.ts";
export { RepositoryArtifactRecorder } from "./repository-artifact-recorder.ts";

export type {
  StoredRawReviewResult,
  StoredValidatedReviewResult,
  StoredReviewFinding,
  StoredExperimentResult,
} from "./stored-models.ts";
export type { StoredReviewArtifact } from "./stored-artifacts.ts";

export {
  StorageError,
  StorageWriteError,
  StorageReadError,
  DuplicateArtifactError,
} from "./storage-errors.ts";
