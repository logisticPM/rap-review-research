import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalCdf,
  wilcoxonSignedRank,
  cliffsDelta,
  bootstrapPairedCI,
  holmBonferroni,
  mean,
  median,
} from "../../src/analysis/stats.ts";

const close = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

test("normalCdf matches known values", () => {
  assert.ok(close(normalCdf(0), 0.5));
  assert.ok(close(normalCdf(1.96), 0.975, 2e-3));
  assert.ok(close(normalCdf(-1.96), 0.025, 2e-3));
  assert.ok(normalCdf(5) > 0.9999);
});

test("wilcoxonSignedRank: all-positive small sample (R V=15, p≈0.06)", () => {
  const r = wilcoxonSignedRank([1, 2, 3, 4, 5]);
  assert.equal(r.n, 5);
  assert.equal(r.wPlus, 15); // all ranks positive
  assert.ok(r.p > 0.05 && r.p < 0.07, `p=${r.p}`);
});

test("wilcoxonSignedRank: drops zero differences", () => {
  const r = wilcoxonSignedRank([0, 0, 1, 2, 3]);
  assert.equal(r.n, 3);
  assert.equal(r.wPlus, 6); // 1+2+3
});

test("wilcoxonSignedRank: strong consistent effect with ties → tiny p", () => {
  const diffs = new Array(20).fill(1); // all +1 (fully tied magnitudes)
  const r = wilcoxonSignedRank(diffs);
  assert.equal(r.n, 20);
  assert.equal(r.wPlus, 210); // 20 * avg-rank 10.5
  assert.ok(r.p < 0.001, `p=${r.p}`);
});

test("wilcoxonSignedRank: symmetric differences → p near 1", () => {
  const r = wilcoxonSignedRank([1, -1, 2, -2, 3, -3]);
  assert.ok(r.p > 0.9, `p=${r.p}`);
});

test("cliffsDelta matches a hand-computed case", () => {
  // a={1,2,3} vs b={0,1,2}: #(a>b)=6, #(a<b)=1 → (6-1)/9
  assert.ok(close(cliffsDelta([1, 2, 3], [0, 1, 2]), 5 / 9));
  assert.equal(cliffsDelta([3, 4], [1, 2]), 1); // total dominance
  assert.equal(cliffsDelta([1, 2], [3, 4]), -1);
  assert.equal(cliffsDelta([2, 2, 2], [2, 2, 2]), 0); // all ties
});

test("holmBonferroni: step-down with monotonicity", () => {
  // sorted 0.01(×3)=0.03, 0.03(×2)=0.06, 0.04(×1)=0.04→bumped to 0.06
  const adj = holmBonferroni([0.01, 0.04, 0.03]);
  assert.ok(close(adj[0]!, 0.03));
  assert.ok(close(adj[1]!, 0.06));
  assert.ok(close(adj[2]!, 0.06));
  // clamped at 1
  assert.equal(holmBonferroni([0.5, 0.9])[1], 1);
});

test("bootstrapPairedCI: point equals statistic, CI brackets it, reproducible", () => {
  const a = [0.6, 0.62, 0.58, 0.65, 0.61, 0.59, 0.63, 0.6];
  const b = [0.5, 0.52, 0.49, 0.55, 0.5, 0.48, 0.53, 0.51];
  const diffMean = (x: readonly number[], y: readonly number[]): number =>
    mean(x.map((xi, i) => xi - y[i]!));
  const ci1 = bootstrapPairedCI(a, b, diffMean, { seed: 42, iters: 1000 });
  const ci2 = bootstrapPairedCI(a, b, diffMean, { seed: 42, iters: 1000 });
  assert.ok(close(ci1.point, 0.1, 0.02)); // a is ~0.1 above b
  assert.ok(ci1.lo <= ci1.point && ci1.point <= ci1.hi);
  assert.equal(ci1.lo, ci2.lo); // seeded → reproducible
  assert.equal(ci1.hi, ci2.hi);
  assert.ok(ci1.lo > 0); // clearly positive difference
});

test("mean and median", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([]), 0);
});
