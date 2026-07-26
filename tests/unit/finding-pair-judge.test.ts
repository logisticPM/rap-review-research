import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewFinding } from "../../src/models/finding.ts";
import {
  buildFindingPairPrompt,
  clusterFindingsSemantically,
  DEFAULT_PAIR_JUDGE_CONFIG,
  FindingPairScoreCache,
  findingPairKey,
  listCandidatePairs,
  type MemberFinding,
} from "../../src/benchmark/matching/finding-pair-judge.ts";

const mk = (id: string, file: string, title: string, line = 10): ReviewFinding => ({
  id, title, category: "correctness", severity: "high", file, line,
  description: `desc-${id}`, recommendation: "r", confidence: 0.8,
});

const a = mk("a", "src/x.ts", "null deref in parse");
const b = mk("b", "src/x.ts", "possible null dereference when parsing", 12);
const c = mk("c", "src/x.ts", "missing await on save", 90);
const d = mk("d", "src/y.ts", "null deref in parse");

test("findingPairKey is order-insensitive and line-insensitive", () => {
  assert.equal(findingPairKey(a, b), findingPairKey(b, a));
  assert.equal(findingPairKey(a, { ...b, line: 999 }), findingPairKey(a, b));
  assert.notEqual(findingPairKey(a, b), findingPairKey(a, c));
});

test("cache round-trips through JSON and is symmetric", () => {
  const cache = new FindingPairScoreCache();
  cache.set(a, b, 0.9);
  assert.equal(cache.get(b, a), 0.9);
  const revived = FindingPairScoreCache.fromJSON(cache.toJSON());
  assert.equal(revived.get(a, b), 0.9);
  assert.equal(revived.size, 1);
  assert.equal(revived.has(a, c), false);
});

test("candidate pairs: same file, different member only", () => {
  const members: MemberFinding[] = [
    { finding: a, member: 0 },
    { finding: b, member: 1 },
    { finding: c, member: 1 },
    { finding: d, member: 2 }, // different file — never a candidate with a/b/c
  ];
  const pairs = listCandidatePairs(members);
  // (a,b) cross-member same-file; (a,c) cross-member same-file; (b,c) same member — excluded.
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map(([x, y]) => [x.id, y.id]), [["a", "b"], ["a", "c"]]);
});

test("clustering links scored pairs ≥ τ, leaves others apart, reports pending", () => {
  const members: MemberFinding[] = [
    { finding: a, member: 0 },
    { finding: b, member: 1 },
    { finding: c, member: 2 },
  ];
  const cache = new FindingPairScoreCache();
  cache.set(a, b, 0.9); // same issue
  cache.set(a, c, 0.1); // different issue
  // (b,c) intentionally unjudged → pending
  const { clusters, pendingPairs } = clusterFindingsSemantically(members, cache, 0.7);
  assert.equal(clusters.length, 2);
  const merged = clusters.find((cl) => cl.findings.length === 2)!;
  assert.equal(merged.rep.id, "a"); // deterministic first-in-order rep
  assert.deepEqual([...merged.members].sort(), [0, 1]);
  assert.equal(pendingPairs.length, 1);
  assert.deepEqual(pendingPairs[0]!.map((f) => f.id), ["b", "c"]);
});

test("clustering is transitive across members (A≈B, B≈C ⇒ one cluster of depth 3)", () => {
  const members: MemberFinding[] = [
    { finding: a, member: 0 },
    { finding: b, member: 1 },
    { finding: { ...c, title: "null deref (parser)", line: 11 }, member: 2 },
  ];
  const cache = new FindingPairScoreCache();
  cache.set(members[0]!.finding, members[1]!.finding, 0.9);
  cache.set(members[1]!.finding, members[2]!.finding, 0.9);
  cache.set(members[0]!.finding, members[2]!.finding, 0.2); // low direct score — still merged transitively
  const { clusters } = clusterFindingsSemantically(members, cache, 0.7);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.members.size, 3);
});

test("prompt carries both findings and the configured model", () => {
  const req = buildFindingPairPrompt(a, b, DEFAULT_PAIR_JUDGE_CONFIG);
  assert.equal(req.modelId, DEFAULT_PAIR_JUDGE_CONFIG.modelId);
  assert.ok(req.userPrompt.includes("null deref in parse"));
  assert.ok(req.userPrompt.includes("possible null dereference when parsing"));
  assert.ok(req.systemPrompt.includes('{"score": n}'));
});
