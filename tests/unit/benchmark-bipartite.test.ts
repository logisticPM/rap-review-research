import { test } from "node:test";
import assert from "node:assert/strict";

import { maxBipartiteMatching } from "../../src/benchmark/matching/bipartite-matcher.ts";

/** Build an adjacency predicate from an explicit edge list. */
function edges(pairs: ReadonlyArray<readonly [number, number]>) {
  const set = new Set(pairs.map(([l, r]) => `${l}:${r}`));
  return (l: number, r: number): boolean => set.has(`${l}:${r}`);
}

test("empty graph has an empty matching", () => {
  assert.equal(maxBipartiteMatching(0, 0, () => true), 0);
  assert.equal(maxBipartiteMatching(3, 0, () => true), 0);
  assert.equal(maxBipartiteMatching(0, 3, () => true), 0);
});

test("one-to-one when every left maps to a distinct right", () => {
  assert.equal(
    maxBipartiteMatching(3, 3, (l, r) => l === r),
    3,
  );
});

test("a single right node can only be matched once", () => {
  // Three left nodes all adjacent only to right 0 → at most one pair.
  assert.equal(
    maxBipartiteMatching(3, 3, (_l, r) => r === 0),
    1,
  );
});

test("finds the maximum (greedy first-fit would miss it)", () => {
  // left0 -> {0}; left1 -> {0, 1}. Greedy processing left1 first takes right0,
  // then left0 has nothing → 1. Maximum is 2 (left0->0, left1->1).
  const adjacent = edges([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  assert.equal(maxBipartiteMatching(2, 2, adjacent), 2);
});

test("matching count is invariant to left-node ordering", () => {
  // Same graph, left nodes relabeled by reversing order.
  const forward = edges([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  const reversed = edges([
    [1, 0],
    [0, 0],
    [0, 1],
  ]);
  assert.equal(
    maxBipartiteMatching(2, 2, forward),
    maxBipartiteMatching(2, 2, reversed),
  );
});
