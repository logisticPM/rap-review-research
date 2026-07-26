import type { GoldenComment } from "../models/golden-comment.ts";
import type {
  SweCoverageDataset,
  SweCoverageInstance,
} from "../models/swe-coverage-dataset.ts";
import { normalizeSeverity } from "./normalize-severity.ts";
import { firstDefined, toStringField } from "./raw-field.ts";
import { DatasetAdapterError } from "../benchmark-errors.ts";

/**
 * Raw Martian golden-comment shapes (tolerant aliases). Golden comments carry no
 * file/line — matching is semantic (SemanticCoverageEvaluator). Confirm the
 * schema against withmartian/code-review-benchmark `offline/golden_comments/`.
 */
export interface SweGoldenRawComment {
  readonly comment?: string;
  readonly body?: string;
  readonly text?: string;
  readonly severity?: string;
}
export interface SweGoldenRawInstance {
  readonly instance_id?: string;
  readonly id?: string;
  readonly url?: string;
  readonly pr_title?: string;
  readonly title?: string;
  readonly patch?: string;
  readonly diff?: string;
  readonly golden_comments?: SweGoldenRawComment[];
  readonly comments?: SweGoldenRawComment[];
}
export interface SweGoldenRawDataset {
  readonly name?: string;
  readonly instances?: SweGoldenRawInstance[];
  readonly rows?: SweGoldenRawInstance[];
  readonly data?: SweGoldenRawInstance[];
}

/** Maps Martian golden-comment rows into a {@link SweCoverageDataset}. */
export class SweGoldenAdapter {
  public toDataset(raw: SweGoldenRawDataset): SweCoverageDataset {
    const instances = firstDefined(raw?.instances, raw?.rows, raw?.data);
    if (!Array.isArray(instances)) {
      throw new DatasetAdapterError(
        "SWE golden dataset is missing an instances array (`instances` | `rows` | `data`).",
      );
    }
    return {
      name: raw.name ?? "SWE-PRBench",
      source: "swe-prbench",
      instances: instances.map((row) => this.toInstance(row)),
    };
  }

  private toInstance(row: SweGoldenRawInstance): SweCoverageInstance {
    const id = firstDefined(row.instance_id, row.id, row.url);
    const patch = firstDefined(row.patch, row.diff);
    if (!id || typeof patch !== "string") {
      throw new DatasetAdapterError(
        `SWE golden row is missing an instance_id/url or patch (id="${id ?? ""}").`,
      );
    }
    const rawComments = firstDefined(row.golden_comments, row.comments) ?? [];
    return {
      instanceId: id,
      title: firstDefined(row.pr_title, row.title) ?? id,
      rawDiff: patch,
      goldenComments: rawComments.map((c, index) => this.toComment(id, c, index)),
    };
  }

  private toComment(
    instanceId: string,
    raw: SweGoldenRawComment,
    index: number,
  ): GoldenComment {
    const body = toStringField(firstDefined(raw.comment, raw.body, raw.text)) ?? "";
    return {
      id: `${instanceId}-gc-${index}`,
      body,
      severity: normalizeSeverity(raw.severity),
    };
  }
}
