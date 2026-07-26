import type { GoldenComment } from "./golden-comment.ts";

/** One SWE-PRBench PR: the diff under review + its location-less golden comments. */
export interface SweCoverageInstance {
  readonly instanceId: string;
  readonly title: string;
  readonly rawDiff: string;
  readonly goldenComments: GoldenComment[];
}

export interface SweCoverageDataset {
  readonly name: string;
  readonly source: "swe-prbench";
  readonly instances: SweCoverageInstance[];
}
