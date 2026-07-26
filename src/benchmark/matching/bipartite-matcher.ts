/**
 * Maximum-cardinality bipartite matching via augmenting paths (Kuhn's
 * algorithm).
 *
 * Given `leftCount` left nodes, `rightCount` right nodes, and an adjacency
 * predicate, returns the largest number of one-to-one pairs. Unlike greedy
 * first-fit, the result is **order-independent**: the maximum cardinality is a
 * property of the graph, so permuting the finding order cannot change the
 * true-positive count.
 *
 * Deterministic and pure. Graphs here are tiny (findings × ground-truth issues,
 * at most a few dozen nodes each), so the O(V·E) augmenting-path search is more
 * than fast enough and avoids a heavier Hopcroft–Karp implementation.
 */
export function maxBipartiteMatching(
  leftCount: number,
  rightCount: number,
  adjacent: (left: number, right: number) => boolean,
): number {
  if (leftCount === 0 || rightCount === 0) {
    return 0;
  }

  // matchRight[r] = the left node currently matched to right node r, or -1.
  const matchRight = new Array<number>(rightCount).fill(-1);

  const augment = (left: number, seen: boolean[]): boolean => {
    for (let right = 0; right < rightCount; right += 1) {
      if (seen[right] || !adjacent(left, right)) {
        continue;
      }
      seen[right] = true;
      const incumbent = matchRight[right] as number;
      if (incumbent === -1 || augment(incumbent, seen)) {
        matchRight[right] = left;
        return true;
      }
    }
    return false;
  };

  let matches = 0;
  for (let left = 0; left < leftCount; left += 1) {
    const seen = new Array<boolean>(rightCount).fill(false);
    if (augment(left, seen)) {
      matches += 1;
    }
  }
  return matches;
}
