/**
 * golden-completeness — FREE diagnostic separating "weak verifier" from
 * "incomplete golden" for the VF-BoN study (doc 08). No LLM calls.
 *
 * V2's precision looked low partly because precision is scored vs. the golden PR
 * comments, which are INCOMPLETE: a real finding the human reviewer never
 * commented on counts as a false positive. This quantifies that using two
 * independent "is it real" signals:
 *   - cross-ARCHITECTURE corroboration: a finding independently produced by >= 2
 *     of the 4 distinct arms (different pipelines) is likely real;
 *   - the DeepSeek V2 verdict (optional, from VERIFIER_CACHE) — an independent model.
 * A non-golden cluster corroborated by multiple arms AND judged real is
 * near-certainly a real issue the golden set omits.
 *
 * Then recomputes STRICT (file+line) P/R/F1 per architecture against
 *   golden        vs        golden ∪ { >=2-arch-corroborated clusters }
 * to show how much precision-vs-golden understates true precision. (A semantic
 * recompute needs new judge pairs = not free; strict is deterministic = free.)
 *
 * Bias caveat: the silver set rewards cross-arm agreement, so it is NOT a
 * neutral oracle — it upper-bounds "how incomplete could golden be", it does not
 * prove each added item real. Read it as a bound, triangulated with DeepSeek.
 *
 * Run: RUNS_IN=<runs.json> [VERIFIER_CACHE=<deepseek verdicts>] npm run golden:completeness
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { BenchmarkRun } from "../src/benchmark/models/benchmark-run.ts";
import type { GroundTruthIssue } from "../src/benchmark/models/ground-truth-issue.ts";
import type { BenchmarkResult } from "../src/benchmark/models/benchmark-result.ts";
import { GroundTruthEvaluator } from "../src/benchmark/ground-truth-evaluator.ts";
import { areDuplicateFindings, dedupeFindings } from "../src/architectures/shared/finding-dedup.ts";

const runsIn = process.env.RUNS_IN;
if (!runsIn || !existsSync(runsIn)) {
  console.error("Set RUNS_IN to a persisted runs JSON.");
  process.exit(1);
}
const runs = JSON.parse(readFileSync(runsIn, "utf8")) as BenchmarkRun[];

type Finding = BenchmarkRun["producedFindings"][number];
const normPath = (p: string): string => p.trim().replace(/^\.\//, "");

// Optional DeepSeek verdicts (key: `${model}|${instanceId}|${file}|${line}|${title}`).
const verdicts: Map<string, boolean> = new Map();
if (process.env.VERIFIER_CACHE && existsSync(process.env.VERIFIER_CACHE)) {
  const raw = JSON.parse(readFileSync(process.env.VERIFIER_CACHE, "utf8")) as Record<string, boolean>;
  for (const [k, v] of Object.entries(raw)) {
    const parts = k.split("|");
    verdicts.set(parts.slice(1).join("|"), v); // drop model prefix -> instanceId|file|line|title
  }
}
const verdictOf = (instanceId: string, f: Finding): boolean | undefined =>
  verdicts.get(`${instanceId}|${f.file}|${f.line}|${f.title}`);

interface XCluster {
  readonly rep: Finding;
  readonly file: string;
  readonly lines: number[];
  readonly arches: Set<string>;
  matchesGolden: boolean;
  deepseekReal: boolean | undefined;
}

const ARCHES = [...new Set(runs.map((r) => r.architecture))];
const byInstance = new Map<string, BenchmarkRun[]>();
for (const r of runs) byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);

// Build cross-arm clusters + per-instance silver ground truth.
const silverByInstance = new Map<string, GroundTruthIssue[]>();
const allClusters: XCluster[] = [];

for (const [instanceId, instanceRuns] of byInstance) {
  const golden = instanceRuns[0]!.groundTruth;
  const clusters: XCluster[] = [];
  for (const run of instanceRuns) {
    for (const f of dedupeFindings(run.producedFindings)) {
      const hit = clusters.find((c) => areDuplicateFindings({ file: c.rep.file, line: c.rep.line, title: c.rep.title }, f));
      if (hit) {
        hit.arches.add(run.architecture);
        hit.lines.push(f.line);
      } else {
        clusters.push({ rep: f, file: f.file, lines: [f.line], arches: new Set([run.architecture]), matchesGolden: false, deepseekReal: undefined });
      }
    }
  }
  for (const c of clusters) {
    c.matchesGolden = golden.some(
      (g) => normPath(g.file) === normPath(c.file) && c.lines.some((l) => l >= g.lineStart && l <= g.lineEnd),
    );
    c.deepseekReal = verdictOf(instanceId, c.rep);
  }
  allClusters.push(...clusters);

  const silver: GroundTruthIssue[] = [...golden];
  clusters
    .filter((c) => !c.matchesGolden && c.arches.size >= 2)
    .forEach((c, i) =>
      silver.push({
        id: `silver-${instanceId}-${i}`,
        file: c.file,
        lineStart: Math.min(...c.lines),
        lineEnd: Math.max(...c.lines),
        title: c.rep.title,
      }),
    );
  silverByInstance.set(instanceId, silver);
}

// --- Diagnostic 1: corroboration of NON-golden findings -----------------------
const nonGolden = allClusters.filter((c) => !c.matchesGolden);
const goldenTotal = [...byInstance.values()].reduce((a, r) => a + r[0]!.groundTruth.length, 0);
const hist = (min: number): number => nonGolden.filter((c) => c.arches.size >= min).length;
const dsReal = (cs: XCluster[]): string => {
  const known = cs.filter((c) => c.deepseekReal !== undefined);
  const real = known.filter((c) => c.deepseekReal);
  return known.length ? `${real.length}/${known.length} (${((real.length / known.length) * 100).toFixed(0)}%)` : "n/a";
};

console.log(`golden-completeness — ${runsIn}`);
console.log(`instances: ${byInstance.size} · golden issues: ${goldenTotal} · cross-arm clusters: ${allClusters.length} (matching golden: ${allClusters.length - nonGolden.length}, not: ${nonGolden.length})\n`);
console.log("NON-golden finding clusters by cross-architecture corroboration:");
console.log("  cor/arches   clusters   DeepSeek-real-rate");
for (const [label, cs] of [
  ["found by 1 arch", nonGolden.filter((c) => c.arches.size === 1)],
  ["found by >=2", nonGolden.filter((c) => c.arches.size >= 2)],
  ["found by >=3", nonGolden.filter((c) => c.arches.size >= 3)],
  ["found by all 4", nonGolden.filter((c) => c.arches.size >= 4)],
] as [string, XCluster[]][]) {
  console.log(`  ${label.padEnd(16)} ${String(cs.length).padStart(5)}        ${dsReal(cs)}`);
}
const silverAdds = hist(2);
console.log(
  `\nHEADLINE: golden lists ${goldenTotal} issues; ${silverAdds} additional issue-clusters are ` +
    `corroborated by >=2 independent architectures (DeepSeek-real on those: ${dsReal(nonGolden.filter((c) => c.arches.size >= 2))}).`,
);
console.log(
  `=> the plausibly-real issue set is ~${goldenTotal + silverAdds}; golden captures only ` +
    `~${((goldenTotal / (goldenTotal + silverAdds)) * 100).toFixed(0)}% of it. Precision-vs-golden is understated accordingly.`,
);

// --- Diagnostic 2: STRICT P/R/F1 per arch, golden vs golden∪silver ------------
const strict = new GroundTruthEvaluator();
function macro(rs: BenchmarkResult[]): { p: number; r: number; f1: number } {
  const n = rs.length || 1;
  return {
    p: rs.reduce((a, x) => a + x.precision, 0) / n,
    r: rs.reduce((a, x) => a + x.recall, 0) / n,
    f1: rs.reduce((a, x) => a + x.f1, 0) / n,
  };
}
console.log(`\n=== STRICT P/R/F1 per architecture — golden vs golden∪silver(>=2 arch) ===`);
console.log("arch".padEnd(14) + "  P: gold→silver   R: gold→silver   F1: gold→silver");
for (const arch of ARCHES) {
  const archRuns = runs.filter((r) => r.architecture === arch);
  const g = macro(archRuns.map((r) => strict.evaluate(r)));
  const s = macro(archRuns.map((r) => strict.evaluate({ ...r, groundTruth: silverByInstance.get(r.instanceId)! })));
  console.log(
    arch.padEnd(14) +
      `  ${g.p.toFixed(2)}→${s.p.toFixed(2)}       ${g.r.toFixed(2)}→${s.r.toFixed(2)}       ${g.f1.toFixed(2)}→${s.f1.toFixed(2)}`,
  );
}
console.log(
  "\nBias caveat: silver rewards cross-arm agreement — an upper bound on golden incompleteness,\n" +
    "triangulated with the independent DeepSeek verdict; not a neutral oracle. Strict-only (free).",
);

if (process.env.GC_OUT) {
  writeFileSync(
    process.env.GC_OUT,
    JSON.stringify(
      { goldenTotal, clusters: allClusters.length, nonGolden: nonGolden.length, silverAdds, byArch: ARCHES }, null, 2,
    ),
  );
}
