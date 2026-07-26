# Research Evaluation Engine (RFC-07)

Turns completed experiments into standardized, reproducible research metrics —
the dataset used to compare review architectures. This is **research
methodology**, not execution infrastructure.

> Spec: `docs/implementaion/07-evaluation-engine.md`

```
StoredExperimentResult → EvaluationEngine → ExperimentMetrics
StoredExperimentResult[] → EvaluationEngine.evaluateBatch → ExperimentComparison[]
```

**Deterministic and pure**: no repositories, no databases, no LLM/Bedrock calls,
no `Date.now`/randomness. It operates only on supplied `StoredExperimentResult`
objects (from the Storage Engine) and never mutates them.

## Files

```
src/evaluation/
├── evaluation-engine.ts     # EvaluationEngine + IEvaluationEngine (orchestrator only)
├── finding-metrics.ts       # FindingMetricsCalculator (review quality)
├── cost-metrics.ts          # CostMetricsCalculator (operational cost, pass-through)
├── evidence-metrics.ts      # EvidenceMetricsCalculator (delegates to IEvidenceScorer)
├── comparison-engine.ts     # ComparisonEngine (group architectures by snapshot)
├── evaluation-errors.ts     # EvaluationError / MetricCalculationError / ComparisonError
├── models/
│   ├── experiment-metrics.ts     # ExperimentMetrics + ReviewQuality/OperationalCost/ResearchEvidence
│   ├── experiment-comparison.ts  # ExperimentComparison
│   └── evaluation-export-row.ts  # EvaluationExportRow + toEvaluationExportRow()
├── scorers/
│   ├── evidence-scorer.ts         # IEvidenceScorer (pluggable strategy)
│   └── heuristic-evidence-scorer.ts
└── industrial/                     # Industrial Verification (RAP Portal, E3) — additive
    ├── architecture-agreement.ts   # cross-architecture agreement
    ├── static-analysis-agreement.ts# agreement vs static-analysis findings
    ├── llm-judge-validation.ts      # rate judged valid by an independent LLM judge
    ├── later-fix-rate.ts           # findings whose lines were changed in later commits
    ├── finding-similarity.ts       # finding↔finding matcher (reuses benchmark IssueMatcher)
    └── industrial-verification.ts  # IndustrialVerification facade
```

## Metric categories

- **Review quality** (`FindingMetricsCalculator`): finding count, per-severity
  counts, average confidence, duplicate count (by `file+line+title`).
- **Operational cost** (`CostMetricsCalculator`): latency, tokens, cost, LLM
  calls, message count — copied through from the stored result unchanged.
- **Research evidence** (`IEvidenceScorer`): the evidence score (a *supporting
  heuristic*, see below) plus the optional industrial-verification signals.

## Industrial Verification (RAP Portal case study, E3)

The RAP Portal has **no authoritative ground truth**, so correctness cannot be
measured directly — Precision/Recall/F1/Localization are intentionally not
reported for it (those belong to Qodo/SWE only). Instead, findings are
*corroborated* by independent signals, computed by `industrial/` and merged into
`ResearchEvidenceMetrics` by two additive engine methods (base `evaluate`/
`evaluateBatch` are unchanged):

```ts
engine.evaluateIndustrial(onePrResults, { staticAnalysisFindings, judgeVerdicts, laterChanges }); // ExperimentMetrics[]
engine.evaluateBatchIndustrial(results);                                    // groups by PR, fills agreement
```

- **`architectureAgreement`** — fraction of an architecture's findings also found
  by ≥1 other architecture on the same PR (matched on file + line window +
  category-or-title similarity). Needs ≥2 architectures; else `undefined`.
- **`staticAnalysisAgreement`** — fraction of findings coinciding with a
  static-analysis issue (file + line + category). Corroboration, **NOT** ground
  truth. Optional; needs `StaticAnalysisFinding`s from a tool run.
- **`llmJudgeValidation`** — fraction of findings an independent LLM judge scored
  `valid` (given the diff). Supporting corroboration, **NOT** ground truth.
  Optional; needs `judgeVerdicts` from a judge run (the LLM call is impure and
  lives outside the engine — only the rate is computed here).
- **`laterFixRate`** — fraction of findings whose location was modified by a later
  commit (weak external evidence). Optional; needs mined `ChangedRange`s.

All are optional and only populated when computable, so an experiment's existing
metrics are unchanged when there is nothing to add. See
`docs/experiments/02-benchmark-selection.md` §6 and §12.

Live demo: `npm run smoke:rap` reviews real `logisticPM/portal` PRs and reports
`architectureAgreement` + `llmJudgeValidation` (live judge) per architecture.

## Evidence scoring (supporting heuristic, pluggable)

`evidenceScore` is a **supporting heuristic, not a correctness metric** — it
combines *self-reported* signals, so a confidently-wrong finding still scores
high. Interpret it only as an indicator of review strength; verification comes
from Industrial Verification (above) and the Qodo/SWE ground-truth benchmarks.
Scoring is behind `IEvidenceScorer` (the engine depends only on the interface);
RFC-07 ships `HeuristicEvidenceScorer`:

```
evidenceScore = 0.4·avgSeverity + 0.4·avgConfidence + 0.2·volumeSignal   (0 when no findings)
  severity: low .25 / medium .5 / high .75 / critical 1
  volumeSignal = min(findingCount / 5, 1)
```

Weights are documented constants (heuristic v1) — the score is derived from
signals, not hard-coded. A future `FinalEvidenceScorer` can replace it without
changing the engine.

## Comparison grouping

`evaluateBatch` evaluates each result (reusing `evaluate`) then `ComparisonEngine`
groups the metrics into `ExperimentComparison`s by **PR snapshot**. The snapshot
id is derived from the experiment id (which is the RFC-01 idempotency key
`snapshotId#architecture#…`, so it's the segment before the first `#`).
See "Deviations" — a future reconciliation could carry `snapshotId` on stored
results directly.

## Usage

```ts
import { EvaluationEngine, toEvaluationExportRow } from "./src/evaluation/index.ts";

const engine = new EvaluationEngine();                 // heuristic scorer by default
const metrics = engine.evaluate(storedExperimentResult);
const comparisons = engine.evaluateBatch(storedExperimentResults);
const row = toEvaluationExportRow(metrics);            // export-ready (no CSV here)
```

Demo: `npm run demo:evaluate` (mock provider; full pipeline → metrics).

## Errors

`EvaluationError` (base) — thrown when a required artifact is missing (no
validated result). `MetricCalculationError` — a calculator failed (identifies
the metric). `ComparisonError` — comparison failure. Missing *optional* evidence
signals never fail evaluation.

## Out of scope (future)

CSV writer, dashboards, statistical significance tests, synthetic
precision/recall/F1/localization, and `acceptedFindingRate` (needs a reviewer-
acceptance capture UI). The `staticAnalysisAgreement` / `laterFixRate` *rate*
calculators exist; their producers — running a static-analysis tool on the PR
and mining later-commit `ChangedRange`s from git — are follow-up. The LLM judge
producer for `llmJudgeValidation` ships in `scripts/rap-portal-smoke.ts`.
