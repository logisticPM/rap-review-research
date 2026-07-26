# Freeze Manifest — `prompt-freeze-v1`

**Status:** Generation-side frozen for the confirmatory campaign (Phase 2).
**Date:** 2026-07-09
**Registers with:** `04-preregistration.md` (the authoritative methodology). This
file pins the exact runtime configuration that `prompt-freeze-v1` (git tag) tags.

> **Double-freeze line.** Everything under "Generation-side (FROZEN)" is fixed at
> this tag and must not change for the confirmatory campaign. Everything under
> "Evaluation-side (replayable)" may still change post-hoc **because all raw LLM
> outputs are persisted (B1) and the deterministic downstream replays** — every
> such change is logged. See pre-registration §7.

## Generation-side (FROZEN)

| Item | Frozen value |
|---|---|
| System under test (default model) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5) |
| Robustness arm (secondary) | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5), via `LLM_DEFAULT_MODEL` |
| Region | `us-east-1` (cross-region inference profiles; pilot-verified enabled) |
| Temperature — agentless / hierarchical / consensus / agentless-large | `0` |
| Temperature — generalists-3 sampling | `0.7` (`sampleTemperature`), `sampleCount = 3` |
| maxTokens | `4096` |
| Confirmatory arms | `agentless`, `generalists-3`, `hierarchical`, `consensus` |
| Exploratory arm (Qodo only) | `agentless-large` (cost-matched to the 3-agent arms) |
| Runs per (PR × arm) | `3` |
| Prompts / role templates / architecture logic | as of this tag (incl. the specialist JSON-schema fix, PR #25) |

## Datasets (FROZEN subset)

| Dataset | File / source | Subset |
|---|---|---|
| Qodo PR-Review-Bench (E1) | `data/benchmark/qodo.json` | 100 PRs (full; 543 located ground-truth issues) |
| SWE-PRBench / Martian (E2) | `data/benchmark/swe-golden.json` | 50 PRs (full Martian set) |
| RAP Portal (E3) | `logisticPM/portal` (live) | 15 PRs — operational/industrial-verification only, no correctness claims |

## Evaluation-side (replayable post-hoc; NOT frozen, but protocol pre-registered)

| Item | Value |
|---|---|
| Judge model (A2 + SWE coverage) | `us.meta.llama3-3-70b-instruct-v1:0` (Llama 3.3 70B — non-Anthropic; avoids self-preference) |
| E1 matcher | `file AND (line overlap OR snippet-anchored line OR judge score ≥ τ)`; strict location-only reported alongside (dual-matcher stability) |
| E2 matcher | semantic coverage — judge "same underlying issue?", no location (`SemanticCoverageEvaluator`) |
| τ (semantic threshold) | `0.7` — pilot showed the judge returns near-binary scores, so any τ∈(0,1) is equivalent |
| Dedup predicate (A4) | `areDuplicateFindings` defaults: same file + line within ±2 + title Jaccard ≥ 0.5 |
| Export schema | `STABLE_COLUMNS` (23) + benchmark CSV + SWE coverage table |

## Reproducibility

- **Tag:** `prompt-freeze-v1` points to the commit that merges this manifest.
- Each experiment records commit hash, platform/prompt/model/workflow/eval
  versions, region, and config (pre-registration §7). Raw outputs + judge caches
  persist so evaluation replays at zero generation cost (`npm run verify:replay`;
  `judge:eval` / `swe:eval` `RUNS_IN`/`CACHE_IN`).
- **Confirmatory data collection begins only after OSF submission.** All runs
  prior to this tag (the N=20 Qodo and N=5/N=20 SWE pilots) are exploratory and
  excluded from the confirmatory analysis (pre-registration §3.4).
- **Runs/instance:** the 3 runs/instance are supplied at launch via
  `RUNS_PER_INSTANCE=3` (env knob added to `judge:eval`/`swe:eval` after the tag;
  the frozen default behavior is unchanged — default 1). This is a conformance
  knob enabling the registered 3-run protocol, not a change to it.
