import type { ReviewArchitecture } from "../../models/experiment.ts";
import type { ArchitectureFindings } from "./models.ts";
import { FindingSimilarity } from "./finding-similarity.ts";

/**
 * Cross-architecture agreement for one PR.
 *
 * For each architecture, the proportion of its findings that were *independently*
 * identified by at least one other architecture (via {@link FindingSimilarity}).
 * A finding corroborated by multiple, differently-structured review pipelines is
 * far more credible than a solo finding — this is the primary automated
 * verification signal for the RAP Portal case study, which has no ground truth.
 *
 * Agreement is undefined (not 0) when it cannot be computed: fewer than two
 * architectures were run, or the architecture produced no findings.
 */
export interface ArchitectureAgreementResult {
  /** Per-architecture agreement in [0, 1]; absent when not computable. */
  readonly byArchitecture: ReadonlyMap<ReviewArchitecture, number>;
  /** Distinct findings (across all architectures) corroborated by ≥1 peer. */
  readonly corroboratedFindingCount: number;
  readonly totalFindingCount: number;
}

export class ArchitectureAgreementCalculator {
  private readonly similarity: FindingSimilarity;

  public constructor(similarity: FindingSimilarity = new FindingSimilarity()) {
    this.similarity = similarity;
  }

  public calculate(groups: ArchitectureFindings[]): ArchitectureAgreementResult {
    const byArchitecture = new Map<ReviewArchitecture, number>();
    let corroborated = 0;
    let total = 0;

    for (const group of groups) {
      const peers = groups.filter((g) => g !== group);
      total += group.findings.length;

      // Agreement is only meaningful with peers and at least one finding.
      if (peers.length === 0 || group.findings.length === 0) {
        continue;
      }

      let matched = 0;
      for (const finding of group.findings) {
        const seenElsewhere = peers.some((peer) =>
          peer.findings.some((other) => this.similarity.agree(finding, other)),
        );
        if (seenElsewhere) {
          matched += 1;
          corroborated += 1;
        }
      }
      byArchitecture.set(group.architecture, matched / group.findings.length);
    }

    return {
      byArchitecture,
      corroboratedFindingCount: corroborated,
      totalFindingCount: total,
    };
  }
}
