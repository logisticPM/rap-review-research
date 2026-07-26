# C1 — Compute-Matched Control Arm (`generalists-3`)

**Date:** 2026-07-08
**Status:** Approved (design)
**Roadmap ref:** `docs/optimization/00-roadmap.md` → C1 (and D1 test-time-compute framing)
**Depends on:** Phase 0 branch `feat/phase-0-eval-integrity` (deterministic `Synthesizer`, `areDuplicateFindings`, dual-latency + truncation metric plumbing)

## Problem

The three existing arms confound three variables at once: **topology**, **role specialization**, and **total compute**. A reviewer's first objection to any P/R/F1 difference is "3 agents beat 1 because you sampled 3×, not because of the topology." Nothing in the current design isolates those factors.

## Goal

Add a single control arm that turns the comparison into a ladder where each adjacent rung differs by exactly one variable:

```
agentless (1 generalist call)
   │  + sample count (compute)
generalists-3 (3 generalist calls + deterministic merge)   ← new
   │  + role specialization
hierarchical (3 specialist calls + deterministic merge)
   │  + inter-agent communication
consensus (3 specialists + exchange/revision/voting rounds)
```

`generalists-3` alone powers two controls: **agentless → generalists-3** isolates *more compute*; **generalists-3 → hierarchical** isolates *specialization* (agent count and merge held constant).

Non-goal: the roadmap's second literal arm (`agentless-sc3`) is dropped — with the merge held constant it is mechanically identical to `generalists-3`.

## Design

### Architecture: `GeneralistsArchitecture` (`name = "generalists-3"`)

Implements `IReviewArchitecture`.

- **Reviews:** runs the **same generalist prompt** the agentless arm uses (common `review-instructions` + agentless role template) **`sampleCount` times** (default 3), dispatched in parallel via `Promise.all` (B3 pattern — requests independent, no data dependency).
- **Diversity:** stochastic sampling at **`sampleTemperature` > 0** (default `0.7`). Each request is built with this sampling temperature, independent of the global `LLM_CONFIG.temperature` (which stays 0 for the other arms). `sampleCount` and `sampleTemperature` are constructor options so the freeze can pin exact values.
- **Merge:** the **same deterministic `Synthesizer`** hierarchical uses (dedup via `areDuplicateFindings`, conflict resolution by highest severity then confidence, duplicate count). Holding the merge constant is what makes the generalists-3 ↔ hierarchical comparison clean.
- **Output:** a `RawReviewResult` shaped exactly like the other arms.

Composition helper `createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage, config?, sampleCount?, sampleTemperature?, clock?, logger? })`, mirroring `createHierarchicalArchitecture`.

### Metrics (reuse Phase 0 infrastructure)

| Metric | Value |
|---|---|
| `llmCalls` | `sampleCount` (3) |
| `messageCount` | `sampleCount` — **zero inter-agent messages** (the research signal: more compute, no communication) |
| `latencyMs` | Σ sample latencies (sum-of-calls) |
| `criticalPathLatencyMs` | max sample latency (single parallel round) — B3 |
| `truncatedCallCount` | count of samples cut off by the token cap — B2 |
| `inputTokens`/`outputTokens`/`estimatedCostUsd` | summed across samples |

### Wiring

- Add `"generalists-3"` to the `ReviewArchitecture` union (`src/models/experiment.ts`). It then flows through evaluation, export, comparison, and campaign summary unchanged (the pipeline is keyed on this type; no exhaustive switches exist).
- Register in `scripts/benchmark-shared.ts` `buildBenchmarkPipeline`.
- **Do not** add to `ALL_ARCHITECTURES` (benchmark-runner default) — existing 3-architecture campaigns stay unchanged; callers opt in via `BenchmarkExecutionConfig.architectures`.

### Testing

`MockProvider` responder returns different findings by call index (deterministic stand-in for diverse samples). Assert:
- `llmCalls === sampleCount`; registry resolves `"generalists-3"`.
- Overlapping samples dedup through the shared `Synthesizer` (merged count < raw count).
- `criticalPathLatencyMs < latencyMs` when sample latencies differ (parallel round).
- `truncatedCallCount` counts truncated samples.
- Distinct findings across samples all survive the merge.

## Scope decisions

- **Artifact persistence deferred** for this control arm. Its per-sample intermediates are not needed for the flagship consensus analyses (C2 operating curve, C3 phase decomposition), so persisting them is YAGNI now. If later wanted, it reuses the B1 `ReviewArtifactRecorder` seam (generalists-3 is structurally "N reviews + merge", i.e. the `HierarchicalReviewResult` shape).
- **Temperature deviation documented** in threats-to-validity: this arm runs at `sampleTemperature > 0` while the others run at temperature 0. This is intrinsic to self-consistency (identical-prompt sampling at temp 0 would be degenerate). Reported, not hidden.

## Freeze classification

Generation-side (adds a new arm that emits findings) → must land **before** the prompt freeze, alongside the other pre-freeze work.
