/**
 * Phase 3 — aggregate the chunked confirmatory runs + judge caches into a single
 * replayable (runs, cache) pair for whole-campaign evaluation, applying the
 * pre-registered PR-level exclusion.
 *
 * ZERO LLM calls. Reads `<PREFIX>-off*-runs.json` (arrays of BenchmarkRun) and
 * `<PREFIX>-off*-cache.json` (flat Record<pairKey, score>) from the results dir,
 * concatenates the runs, merges the caches (disjoint keys across chunks — PRs do
 * not overlap), drops excluded instances, and writes `<PREFIX>-all-runs.json` +
 * `<PREFIX>-all-cache.json` for `judge:eval` / `bon:eval` replay
 * (RUNS_IN=/CACHE_IN=).
 *
 * This is an ANALYSIS-side tool (evaluation replays from persisted artifacts,
 * pre-registration §5 / freeze double-freeze line) — it does not touch the
 * frozen generation config.
 *
 * Env:
 *   PHASE2_OUT_DIR      results dir (default: <repo>/phase2-results)
 *   AGG_PREFIX          chunk prefix, `qodo` (E1) or `swe` (E2). Default `qodo`.
 *   EXCLUDE_INSTANCES   comma-separated instanceIds to drop (pre-registered
 *                       exclusion). Default `Ghost-pr-4` (flaky-JSON PR — its
 *                       agentless arm never yields 3 parseable runs; dropped and
 *                       reported per the registered exclusion rule).
 *   AGG_DATASET_ID      if set, keep only runs with this datasetId (isolates the
 *                       primary Qodo set from the legacy SWE fold-in in off0).
 *   RUNS_PER_INSTANCE   expected runs per (complete) instance for the sanity
 *                       check (default 12 = 4 arch × 3 runs).
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";

const OUT_DIR = resolve(
  process.env.PHASE2_OUT_DIR ?? join(import.meta.dirname, "..", "phase2-results"),
);
const PREFIX = process.env.AGG_PREFIX ?? "qodo";
const EXCLUDE = (process.env.EXCLUDE_INSTANCES ?? "Ghost-pr-4")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DATASET_ID = process.env.AGG_DATASET_ID;
const EXPECTED_PER_INSTANCE = Math.max(1, Number(process.env.RUNS_PER_INSTANCE ?? 12));

if (!existsSync(OUT_DIR)) {
  console.error(`results dir not found: ${OUT_DIR}`);
  process.exit(1);
}

const files = readdirSync(OUT_DIR);
const runFiles = files.filter((f) => new RegExp(`^${PREFIX}-off\\d+-runs\\.json$`).test(f)).sort();
const cacheFiles = files.filter((f) => new RegExp(`^${PREFIX}-off\\d+-cache\\.json$`).test(f)).sort();
console.log(`prefix=${PREFIX}  runFiles=${runFiles.length}  cacheFiles=${cacheFiles.length}  dir=${OUT_DIR}`);

let allRuns: BenchmarkRun[] = [];
for (const f of runFiles) {
  allRuns = allRuns.concat(JSON.parse(readFileSync(join(OUT_DIR, f), "utf8")) as BenchmarkRun[]);
}

function summarize(runs: BenchmarkRun[], label: string): void {
  const datasetInstances = new Map<string, Set<string>>();
  const byArch = new Map<string, number>();
  const runsByInstance = new Map<string, number>();
  for (const r of runs) {
    if (!datasetInstances.has(r.datasetId)) datasetInstances.set(r.datasetId, new Set());
    datasetInstances.get(r.datasetId)!.add(r.instanceId);
    byArch.set(r.architecture, (byArch.get(r.architecture) ?? 0) + 1);
    runsByInstance.set(r.instanceId, (runsByInstance.get(r.instanceId) ?? 0) + 1);
  }
  console.log(`\n=== ${label}: ${runs.length} runs, ${runsByInstance.size} instances ===`);
  for (const [ds, insts] of datasetInstances) console.log(`  datasetId "${ds}": ${insts.size} instances`);
  console.log("  by arch: " + [...byArch.entries()].map(([a, n]) => `${a}=${n}`).join("  "));
  const incomplete = [...runsByInstance.entries()]
    .filter(([, n]) => n !== EXPECTED_PER_INSTANCE)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (incomplete.length) {
    console.log(`  ⚠ instances not at exactly ${EXPECTED_PER_INSTANCE} runs: ` +
      incomplete.map(([i, n]) => `${i}(${n})`).join(", "));
  } else {
    console.log(`  ✓ every instance has exactly ${EXPECTED_PER_INSTANCE} runs`);
  }
}

summarize(allRuns, "RAW (all chunks concatenated)");

let filtered = allRuns;
if (DATASET_ID) {
  const before = filtered.length;
  filtered = filtered.filter((r) => r.datasetId === DATASET_ID);
  console.log(`\ndatasetId filter "${DATASET_ID}": kept ${filtered.length}/${before} runs`);
}
const beforeExcl = filtered.length;
filtered = filtered.filter((r) => !EXCLUDE.includes(r.instanceId));
console.log(`exclusion ${JSON.stringify(EXCLUDE)}: dropped ${beforeExcl - filtered.length} runs`);

summarize(filtered, "FILTERED (for confirmatory analysis)");

const mergedCache: Record<string, number> = {};
for (const f of cacheFiles) {
  Object.assign(mergedCache, JSON.parse(readFileSync(join(OUT_DIR, f), "utf8")) as Record<string, number>);
}

const runsOut = join(OUT_DIR, `${PREFIX}-all-runs.json`);
const cacheOut = join(OUT_DIR, `${PREFIX}-all-cache.json`);
writeFileSync(runsOut, JSON.stringify(filtered, null, 2));
writeFileSync(cacheOut, JSON.stringify(mergedCache, null, 2));
console.log(`\nwrote ${filtered.length} runs → ${runsOut}`);
console.log(`wrote ${Object.keys(mergedCache).length} cached pairs → ${cacheOut}`);
