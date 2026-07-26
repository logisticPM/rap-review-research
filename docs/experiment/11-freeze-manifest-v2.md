# Freeze Manifest v2 — `prompt-freeze-v2`

**Status:** ADDITIVE freeze for the OSF pre-data amendment (`10-registration-amendment.md`).
**Date:** 2026-07-13
**Registers with:** `04-preregistration.md` + its OSF amendment (docs 10).
This file pins the runtime configuration that git tag `prompt-freeze-v2` tags.

> **Additive freeze.** Everything in `05-freeze-manifest.md` /
> `prompt-freeze-v1` is UNCHANGED and remains the frozen generation config for
> the primary four-arm campaign. v2 only ADDS (a) two companion generating
> models for the heterogeneous-corroboration hypothesis and (b) a cross-model
> finding↔finding pair judge. Nothing in v1 is altered, re-tuned, or removed.
> The double-freeze line from v1 still applies.

## Added generation-side (FROZEN at this tag)

| Item | Frozen value |
|---|---|
| Companion member A | `moonshotai.kimi-k2.5` (Kimi K2.5) |
| Companion member B | `zai.glm-5` (GLM 5) |
| Companion arm | `agentless` only (single-pass review) |
| Companion prompt | **v1 prompt, UNCHANGED** (`templates/v1/agentless` + common) — no per-model adaptation; the frozen-prompt comparison regime is preserved |
| Companion temperature / maxTokens | `0` / `4096` (same as the frozen agentless arm) |
| Runs per (PR × companion model) | `3` |
| Region | `us-east-1` (in-region; both models pilot-verified enabled) |
| Quota isolation | companion models run on their own Bedrock quotas — independent of the Haiku daily-token quota that gates the primary campaign |

## Member-selection gate (FROZEN rule, already applied)

| Item | Value |
|---|---|
| Parity gate | single-arm **semantic F1 ≥ 0.85 × best family** |
| Screened (unadapted v1 prompt, pilot dev set) | Kimi K2.5 ratio 0.98 **PASS**; GLM 5 ratio 1.00 **PASS** (eval-batch); Devstral 2 0.42 FAIL, Qwen3 Coder Next 0.38 FAIL |
| Selection provenance | `data/experiments/2026-07-13-phaseb/adaptation-log.md`, doc 09 §8.1 |

## Added evaluation-side (replayable; protocol pre-registered)

| Item | Value |
|---|---|
| Cross-model pair judge (finding↔finding) | `us.amazon.nova-pro-v1:0` (Amazon Nova Pro) — a **fourth** family, distinct from all three generators and from the finding→golden judge |
| Pair threshold τ_pair | `0.7` — near-binary/insensitive (0.5/0.7/0.9 equivalent in Phase C) |
| Corroboration depth | number of distinct model families independently producing a semantically-matched finding (union-find over cached pair scores) |
| finding→golden judge (unchanged) | `us.meta.llama3-3-70b-instruct-v1:0` (Llama 3.3 70B) |

## Pre-specified exclusion (from doc 10)

- The ≤21 pilot Qodo PRs used to screen/gate the companion members are
  **excluded from the H-hetero-precision confirmatory test** (computed on the
  disjoint remainder of Qodo 100). The primary H2 analysis is unaffected and
  uses the full Qodo 100.

## Reproducibility

- **Tag:** `prompt-freeze-v2` points to the commit that adds this manifest;
  `prompt-freeze-v1` is unchanged and remains authoritative for the primary
  campaign.
- Companion generation uses the existing `hetero:eval` path (agentless × 3 per
  model) and the cross-model matcher uses `hetero:recluster`
  (`FAMILIES`/`GOLDEN_CACHE` env); both persist runs + pair-judge caches so the
  analysis replays at zero further generation cost (B1).
- **Companion confirmatory data collection begins only after the OSF amendment
  is approved.** All heterogeneous runs prior to this tag (docs 08–09 Phase
  A/C pilots, N≤21) are exploratory and excluded from the confirmatory
  analysis.
