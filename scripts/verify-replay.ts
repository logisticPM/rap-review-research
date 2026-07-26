/**
 * Replay verification (roadmap B1).
 *
 * Runs the multi-agent architectures once (mock provider), then recomputes each
 * one's final findings *from the persisted intermediate artifact alone* — no
 * LLM calls — and checks the recomputed findings match what the live run
 * produced. This is the guarantee that lets the evaluation side iterate after a
 * frozen campaign without re-paying for inference. Exits non-zero on mismatch.
 *
 *   npm run verify:replay
 */
import {
  replayHierarchicalFindings,
  replayConsensusFindings,
} from "../src/architectures/replay.ts";
import type { ReviewFinding } from "../src/models/finding.ts";
import { buildBenchmarkPipeline } from "./benchmark-shared.ts";

const SAMPLE_DIFF = `diff --git a/src/api/users.ts b/src/api/users.ts
--- a/src/api/users.ts
+++ b/src/api/users.ts
@@ -8,6 +8,9 @@ export async function getUser(req, res) {
-  const id = req.params.id;
+  const id = req.query.id;
+  const rows = await db.query('SELECT * FROM users WHERE id = ' + id);
+  return res.json(rows[0]);
 }
`;

function summarize(findings: ReviewFinding[]): string {
  return findings.map((f) => `${f.file}:${f.line} ${f.title}`).join(" | ") || "(none)";
}

async function main(): Promise<void> {
  const pipeline = buildBenchmarkPipeline();
  const imported = await pipeline.importService.importManualDiff({
    title: "Replay sample",
    source: "manual",
    rawDiff: SAMPLE_DIFF,
  });

  const cases: Array<{
    architecture: "hierarchical" | "consensus";
    replay: (artifact: NonNullable<unknown>) => ReviewFinding[];
  }> = [
    {
      architecture: "hierarchical",
      replay: (a) => replayHierarchicalFindings((a as { hierarchical: Parameters<typeof replayHierarchicalFindings>[0] }).hierarchical),
    },
    {
      architecture: "consensus",
      replay: (a) => replayConsensusFindings((a as { consensus: Parameters<typeof replayConsensusFindings>[0] }).consensus),
    },
  ];

  let failures = 0;
  for (const { architecture, replay } of cases) {
    const run = await pipeline.experimentService.runExperiment({
      snapshotId: imported.snapshotId,
      architecture,
      modelVersion: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      promptVersion: "v1",
      workflowVersion: "workflow-v1",
      evaluationVersion: "eval-v1",
    });

    const stored = await pipeline.storage.getExperimentResult(run.experimentId);
    // Compare against the raw synthesis output — that is exactly what replay
    // reproduces (validation is a separate downstream transform).
    const live = (stored?.rawResult?.findings ?? []) as ReviewFinding[];

    const artifact = await pipeline.artifacts.getByExperimentId(run.experimentId);
    if (!artifact) {
      console.error(`✗ ${architecture}: no intermediate artifact persisted`);
      failures += 1;
      continue;
    }

    const replayed = replay(artifact);
    const ok = JSON.stringify(replayed) === JSON.stringify(live);
    console.log(
      `${ok ? "✓" : "✗"} ${architecture}: replayed ${replayed.length} finding(s) from stored artifact` +
        ` — ${ok ? "matches live run (0 LLM calls)" : "MISMATCH"}`,
    );
    if (!ok) {
      console.error(`    live:     ${summarize(live)}`);
      console.error(`    replayed: ${summarize(replayed)}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`\nReplay verification FAILED (${failures} mismatch).`);
    process.exit(1);
  }
  console.log("\nReplay verification passed: intermediates fully reproduce final findings.");
}

await main();
