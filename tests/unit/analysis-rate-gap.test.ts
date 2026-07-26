import { test } from "node:test";
import assert from "node:assert/strict";

import { pooledRateGap, bootstrapRateGapCI, type RatePair } from "../../src/analysis/stats.ts";

test("pooledRateGap: micro-averaged gap over units (small units do not overweigh)", () => {
  const units: RatePair[] = [
    { xHits: 2, xN: 2, yHits: 1, yN: 2 },
    { xHits: 1, xN: 2, yHits: 0, yN: 2 },
  ];
  const { xRate, yRate, gap } = pooledRateGap(units);
  assert.equal(xRate, 3 / 4); // (2+1)/(2+2)
  assert.equal(yRate, 1 / 4); // (1+0)/(2+2)
  assert.equal(gap, 0.5);
});

test("pooledRateGap: empty denominators are 0, not NaN", () => {
  const { xRate, yRate, gap } = pooledRateGap([{ xHits: 0, xN: 0, yHits: 0, yN: 0 }]);
  assert.equal(xRate, 0);
  assert.equal(yRate, 0);
  assert.equal(gap, 0);
});

test("pooledRateGap over no units is a 0 gap", () => {
  assert.deepEqual(pooledRateGap([]), { xRate: 0, yRate: 0, gap: 0 });
});

test("bootstrapRateGapCI: seeded → byte-reproducible, and brackets the point", () => {
  const units: RatePair[] = Array.from({ length: 40 }, (_, i) => ({
    xHits: i % 5 === 0 ? 0 : 1, // ~0.8 pooled
    xN: 1,
    yHits: i % 2 === 0 ? 1 : 0, // ~0.5 pooled
    yN: 1,
  }));
  const ci1 = bootstrapRateGapCI(units, { iters: 500, seed: 7 });
  const ci2 = bootstrapRateGapCI(units, { iters: 500, seed: 7 });
  assert.deepEqual(ci1, ci2); // deterministic under a fixed seed
  assert.ok(ci1.lo <= ci1.point && ci1.point <= ci1.hi, "point inside CI");
  assert.ok(ci1.point > 0, "x-rate exceeds y-rate here"); // ~0.8 − 0.5
});

test("bootstrapRateGapCI: a genuine positive gap keeps the CI lower bound above 0", () => {
  // Strong, consistent gap: x always hits, y never — CI must sit well above 0.
  const units: RatePair[] = Array.from({ length: 60 }, () => ({ xHits: 3, xN: 3, yHits: 0, yN: 3 }));
  const ci = bootstrapRateGapCI(units, { iters: 800, seed: 20260715 });
  assert.equal(ci.point, 1);
  assert.ok(ci.lo > 0.5, "lower bound stays high for a saturated gap");
});
