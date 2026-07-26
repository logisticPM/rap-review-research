/**
 * Phase 2 unattended driver — runs the confirmatory campaign chunk-by-chunk,
 * skipping chunks that already completed cleanly and riding through chunk
 * failures so a long unattended run survives transient trouble. Resume by
 * simply re-running: a chunk with a `.done` marker (written only when its
 * `phase2-generation` line reports complete=true — every intended instance has
 * a full run set) is skipped. Resume is also INSTANCE-LEVEL *within* a chunk:
 * each attempt carries already-complete instances (via RUNS_RESUME_IN, set here
 * to the chunk's own runs file) and regenerates only incomplete ones, so a
 * daily-token-cap failure mid-chunk does not re-spend budget re-running the
 * instances that already succeeded.
 *
 * Run with: `node scripts/phase2-driver.ts`
 *
 * Credentials come from the environment / AWS default provider chain. For a
 * genuine unattended run use an auto-refreshing SSO profile (AWS_PROFILE=...),
 * NOT a static STS token that expires mid-run — see docs/experiment/07-*.md.
 *
 * Env:
 *   PHASE2_OUT_DIR         where run/cache/marker/log files live (=phase2-results)
 *   RUNS_PER_INSTANCE      registered protocol is 3 (=3)
 *   PHASE2_CHUNK_PAUSE_MS  pause between chunks to let per-minute windows breathe (=30000)
 *   PHASE2_DRY_RUN=1       print the chunk plan + skip/run decisions, spawn nothing
 *   PHASE2_SELFTEST=1      spawn a trivial child emitting a fake campaign-finished
 *                          line to verify parse + marker logic for free (isolated dir)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

interface Chunk {
  readonly id: string;
  readonly script: "judge:eval" | "swe:eval";
  readonly offset: number;
  readonly limit: number;
}

interface ChunkResult {
  /** Every intended instance of the chunk now has its full run set. */
  readonly complete: boolean;
  /** Runs generated this attempt (freshly executed). */
  readonly generated: number;
  /** Runs carried from already-complete instances (skipped — the budget win). */
  readonly carried: number;
  /** Total runs in the merged chunk (generated + carried). */
  readonly total: number;
}

const DRY_RUN = process.env.PHASE2_DRY_RUN === "1";
const SELFTEST = process.env.PHASE2_SELFTEST === "1";
const OUT_DIR = resolve(
  process.env.PHASE2_OUT_DIR ?? (SELFTEST ? "phase2-results-selftest" : "phase2-results"),
);
const RUNS_PER_INSTANCE = process.env.RUNS_PER_INSTANCE ?? "3";
const CHUNK_PAUSE_MS = Math.max(0, Number(process.env.PHASE2_CHUNK_PAUSE_MS ?? 30_000));

// Small chunks (5 PRs) so an interrupted run — shutdown or sleep mid-chunk —
// loses at most one chunk's generation; completed chunks are skipped via on-disk
// .done markers, and each chunk's runs/cache persist to its own file. Smaller
// chunks add only trivial per-spawn overhead: the legacy 1-instance swe.json that
// judge:eval folds into the Qodo path lands ONLY on the offset-0 chunk (higher
// offsets slice past it), so it is not re-run per chunk. campaign-finished counts
// are parsed rather than hard-coded, so the fold-in needs no special accounting.
const CHUNK_SIZE = 5;
const offsets = (total: number): number[] =>
  Array.from({ length: Math.ceil(total / CHUNK_SIZE) }, (_, i) => i * CHUNK_SIZE);
const CHUNKS: readonly Chunk[] = [
  // Qodo 100 PRs → twenty 5-PR chunks.
  ...offsets(100).map(
    (offset): Chunk => ({ id: `qodo-off${offset}`, script: "judge:eval", offset, limit: CHUNK_SIZE }),
  ),
  // SWE-PRBench 50 PRs (semantic coverage) → ten 5-PR chunks.
  ...offsets(50).map(
    (offset): Chunk => ({ id: `swe-off${offset}`, script: "swe:eval", offset, limit: CHUNK_SIZE }),
  ),
];

// The eval scripts print an authoritative, resume-aware completion line
// (src/benchmark/resume-plan.ts): a chunk is DONE iff every intended instance
// has its full run set — whether freshly generated or carried from a prior
// attempt. This supersedes the runner's per-batch `campaign-finished` line,
// which (under resume) reflects only the instances re-run this attempt.
const STATUS_RE =
  /phase2-generation complete=(true|false) generated=(\d+) carried=(\d+) total=(\d+) expected=(\d+)/;

function markerPath(chunk: Chunk): string {
  return join(OUT_DIR, `${chunk.id}.done`);
}

function isComplete(chunk: Chunk): boolean {
  return existsSync(markerPath(chunk));
}

function chunkEnv(chunk: Chunk): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BENCHMARK_OFFSET: String(chunk.offset),
    BENCHMARK_LIMIT: String(chunk.limit),
    RUNS_PER_INSTANCE,
    RUNS_OUT: join(OUT_DIR, `${chunk.id}-runs.json`),
    // Instance-level resume: the eval script reads this chunk's own prior runs,
    // carries already-complete instances, and regenerates only incomplete ones
    // (same path as RUNS_OUT — written at end of each attempt).
    RUNS_RESUME_IN: join(OUT_DIR, `${chunk.id}-runs.json`),
    CACHE_OUT: join(OUT_DIR, `${chunk.id}-cache.json`),
  };
}

function runChunk(chunk: Chunk): Promise<ChunkResult | null> {
  const logPath = join(OUT_DIR, `${chunk.id}.log`);
  // SELFTEST spawns node with a canned status line so the parse/marker path can
  // be exercised without a live (paid) Bedrock run.
  const command = SELFTEST ? process.execPath : "npm";
  const args = SELFTEST
    ? ["-e", "console.log('phase2-generation complete=true generated=252 carried=0 total=252 expected=252')"]
    : ["run", chunk.script];

  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env: chunkEnv(chunk),
      // `npm` on Windows resolves to npm.cmd only through a shell. The SELFTEST
      // path spawns node.exe directly, whose path contains a space, so it must
      // NOT go through the shell (array args are passed literally without it).
      shell: !SELFTEST && process.platform === "win32",
    });
    let captured = "";
    const onData = (buf: Buffer): void => {
      const text = buf.toString();
      captured += text;
      process.stdout.write(text);
      appendFileSync(logPath, text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", () => {
      const match = STATUS_RE.exec(captured);
      if (!match) {
        resolvePromise(null);
        return;
      }
      resolvePromise({
        complete: match[1] === "true",
        generated: Number(match[2] ?? "0"),
        carried: Number(match[3] ?? "0"),
        total: Number(match[4] ?? "0"),
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- main --------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const mode = DRY_RUN ? " [DRY RUN]" : SELFTEST ? " [SELFTEST]" : "";
console.log(
  `Phase 2 driver — ${CHUNKS.length} chunks, out=${OUT_DIR}, runs/instance=${RUNS_PER_INSTANCE}${mode}`,
);

const summary: string[] = [];
for (const chunk of CHUNKS) {
  if (isComplete(chunk)) {
    console.log(`SKIP  ${chunk.id} (already complete)`);
    summary.push(`${chunk.id}: skipped (done)`);
    continue;
  }
  if (DRY_RUN) {
    console.log(`RUN   ${chunk.id}  npm run ${chunk.script}  offset=${chunk.offset} limit=${chunk.limit}`);
    summary.push(`${chunk.id}: would run`);
    continue;
  }

  console.log(`\n=== ${chunk.id}: npm run ${chunk.script} (offset=${chunk.offset} limit=${chunk.limit}) ===`);
  const result = await runChunk(chunk);
  if (result && result.complete) {
    writeFileSync(
      markerPath(chunk),
      `complete total=${result.total} (generated=${result.generated} carried=${result.carried}) at ${new Date().toISOString()}\n`,
    );
    console.log(`DONE  ${chunk.id}: ${result.total} runs (generated=${result.generated} carried=${result.carried}, marker written)`);
    summary.push(`${chunk.id}: DONE ${result.total} (gen=${result.generated} carried=${result.carried})`);
  } else if (result) {
    console.log(
      `INCOMPLETE ${chunk.id}: ${result.total} runs so far (generated=${result.generated} this attempt) — will retry on next run`,
    );
    summary.push(`${chunk.id}: incomplete ${result.total} (gen=${result.generated})`);
  } else {
    console.log(`INCOMPLETE ${chunk.id}: no phase2-generation line — will retry on next run`);
    summary.push(`${chunk.id}: incomplete (no status line)`);
  }
  if (CHUNK_PAUSE_MS > 0) await sleep(CHUNK_PAUSE_MS);
}

console.log(`\n=== Phase 2 driver summary ===`);
for (const line of summary) console.log(`  ${line}`);
const remaining = CHUNKS.filter((chunk) => !isComplete(chunk)).length;
console.log(
  remaining === 0
    ? "All chunks complete."
    : `${remaining} chunk(s) still incomplete — re-run this driver to resume.`,
);
