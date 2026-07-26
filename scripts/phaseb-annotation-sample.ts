/**
 * phaseb-annotation-sample — doc 09 Phase B(ii): build the 50-pair human
 * validation sample for the cross-model pair judge. Zero LLM calls.
 *
 * Reads the committed pair-judge cache, reconstructs each pair's content from
 * its key, and draws a DETERMINISTIC stratified sample (low/mid/high judge
 * score, evenly spaced within each stratum after a stable sort) so the sample
 * is reproducible from the repo alone. Emits:
 *   annotation-sheet.csv  — BLIND: no judge score; two annotators fill
 *                           same_issue with y/n independently
 *   annotation-key.csv    — the judge's score per pair_id (open after both
 *                           annotators finish; report Cohen's kappa and
 *                           judge-vs-human agreement in doc 09)
 *
 * Run:  npm run phaseb:sample
 * Env:  PAIR_CACHE (=data/experiments/2026-07-12-hetero-team/pair-judge-cache.json)
 *       OUT_DIR (=data/experiments/2026-07-13-phaseb), SAMPLE_N (=50)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const PAIR_CACHE = resolve(
  process.env.PAIR_CACHE ?? "data/experiments/2026-07-12-hetero-team/pair-judge-cache.json",
);
const OUT_DIR = resolve(process.env.OUT_DIR ?? "data/experiments/2026-07-13-phaseb");
const SAMPLE_N = Math.max(3, Number(process.env.SAMPLE_N ?? 50));

if (!existsSync(PAIR_CACHE)) {
  console.error(`missing ${PAIR_CACHE}`);
  process.exit(1);
}
const cache = JSON.parse(readFileSync(PAIR_CACHE, "utf8")) as Record<string, number>;

// Key = JSON.stringify([file,title,desc]) + "||" + JSON.stringify([file,title,desc]).
// "||" may occur inside content, so try every separator position until both
// halves parse as 3-string arrays.
type Side = [string, string, string];
function parseKey(key: string): { a: Side; b: Side } | undefined {
  let idx = key.indexOf("||");
  while (idx !== -1) {
    try {
      const a = JSON.parse(key.slice(0, idx)) as unknown;
      const b = JSON.parse(key.slice(idx + 2)) as unknown;
      const ok = (x: unknown): x is Side => Array.isArray(x) && x.length === 3 && x.every((s) => typeof s === "string");
      if (ok(a) && ok(b)) return { a, b };
    } catch {
      /* not this separator — keep scanning */
    }
    idx = key.indexOf("||", idx + 1);
  }
  return undefined;
}

interface Pair { key: string; score: number; a: Side; b: Side }
const pairs: Pair[] = [];
let unparsed = 0;
for (const [key, score] of Object.entries(cache)) {
  const parsed = parseKey(key);
  if (parsed) pairs.push({ key, score, ...parsed });
  else unparsed += 1;
}
pairs.sort((x, y) => (x.key < y.key ? -1 : 1)); // stable, reproducible order

const strata: [string, Pair[]][] = [
  ["low (<0.3)", pairs.filter((p) => p.score < 0.3)],
  ["mid (0.3–0.7)", pairs.filter((p) => p.score >= 0.3 && p.score < 0.7)],
  ["high (≥0.7)", pairs.filter((p) => p.score >= 0.7)],
];
const per = Math.floor(SAMPLE_N / strata.length);
const sample: Pair[] = [];
for (const [, list] of strata) {
  const want = Math.min(per, list.length);
  for (let i = 0; i < want; i += 1) {
    sample.push(list[Math.floor((i * list.length) / want)]!); // evenly spaced
  }
}
// top up from the largest stratum if a stratum was short
for (const [, list] of [...strata].sort((a, b) => b[1].length - a[1].length)) {
  for (const p of list) {
    if (sample.length >= SAMPLE_N) break;
    if (!sample.includes(p)) sample.push(p);
  }
}

const csv = (s: string): string => `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ").slice(0, 500)}"`;
const sheet = [
  "pair_id,file,A_title,A_description,B_title,B_description,same_issue(y/n),annotator_note",
  ...sample.map((p, i) =>
    [
      `P${String(i + 1).padStart(2, "0")}`,
      csv(p.a[0]),
      csv(p.a[1]),
      csv(p.a[2]),
      csv(p.b[1]),
      csv(p.b[2]),
      "",
      "",
    ].join(","),
  ),
].join("\n");
const keyFile = [
  "pair_id,judge_score",
  ...sample.map((p, i) => `P${String(i + 1).padStart(2, "0")},${p.score}`),
].join("\n");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "annotation-sheet.csv"), sheet);
writeFileSync(join(OUT_DIR, "annotation-key.csv"), keyFile);

console.log(`pairs in cache: ${pairs.length} (${unparsed} unparseable keys)`);
for (const [label, list] of strata) console.log(`  stratum ${label.padEnd(14)} ${list.length}`);
console.log(`sample: ${sample.length} pairs (deterministic, stratified)`);
console.log(`→ ${join(OUT_DIR, "annotation-sheet.csv")} (BLIND — annotate before opening the key)`);
console.log(`→ ${join(OUT_DIR, "annotation-key.csv")}`);
