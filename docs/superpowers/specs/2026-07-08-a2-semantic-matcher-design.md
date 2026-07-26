# A2 — LLM-Judge Semantic Matcher (design)

**Date:** 2026-07-08
**Status:** Approved (design)
**Roadmap ref:** `docs/optimization/00-roadmap.md` → A2; resolves pre-registration DECISION 4.
**Depends on:** existing `ISemanticMatcher` seam, `IssueMatcher`, `ILLMProvider`/`BedrockProvider` (all merged).

## Problem

Ground-truth matching today is `file AND line-overlap` (`NoopSemanticMatcher`
returns `undefined`). This systematically under-counts true positives when a
finding identifies the right issue on a nearby line or with different wording,
and the noise is **architecture-dependent** (consensus/hierarchical rewrite
titles/locations), which biases the primary P/R/F1 comparison. Qodo's own
methodology is LLM-as-judge; strict-only matching deflates recall.

## Goal

Add a real semantic matcher: an LLM judge (a **Bedrock non-Anthropic** model — a
different family than the Claude systems under test) that scores whether a
produced finding and a ground-truth issue describe the same problem, used as
`matched = file AND (line-overlap OR judge-score ≥ τ)`. Strict matching stays
available for the dual-matcher stability report.

## Key constraint & chosen approach (Approach A)

`ISemanticMatcher.score()` — and the whole matching path (`IssueMatcher.match` →
`GroundTruthEvaluator.evaluate` → the bipartite predicate) — is **synchronous**.
An LLM judge is async. **Approach A** isolates the async work into a *precompute
pass* that fills a **persisted score cache**; the sync matcher reads the cache.
The merged sync evaluator is untouched, and scores are a replayable artifact
(zero judge cost on re-run) — consistent with B1 and the double-freeze line.

## Components (all under `src/benchmark/matching/`)

### 1. Judge prompt + parser — `judge-prompt.ts`
- `buildJudgePrompt(finding, issue, config): LLMReviewRequest` — system prompt
  instructs the judge to decide whether the two describe the same issue and
  return `{"score": <0..1>}`; user prompt renders both (file, line(s), title,
  description). `temperature: 0`, small `maxTokens`, `modelId = config.modelId`.
- `parseJudgeScore(text): number | undefined` — tolerant JSON extraction of
  `score`, clamped to [0,1]; returns `undefined` on any parse failure (→ the
  matcher falls back to line-only for that pair).

### 2. `SemanticScoreCache` — `semantic-score-cache.ts`
- Keyed by a stable content hash of the pair: `pairKey(finding, issue)` over
  `finding.{file,line,title,description}` + `issue.{file,lineStart,lineEnd,description}`.
- `get(finding, issue): number | undefined`, `set(finding, issue, score)`.
- `toJSON()/fromJSON(...)` so the cache can be persisted and reloaded (replay).

### 3. `JudgeScorePrecomputer` — `judge-score-precomputer.ts` (async)
- `constructor(provider: ILLMProvider, config: JudgeConfig)` where
  `JudgeConfig = { modelId; temperature; maxTokens }`.
- `precompute(runs: BenchmarkRun[], cache: SemanticScoreCache): Promise<void>` —
  for each run, for each **candidate pair only** — `same file AND NOT line
  overlap` (the only pairs whose `matched` a semantic score can flip) — that is
  not already cached: build prompt, `provider.review`, parse, and `cache.set`
  on success. This bounds judge calls tightly. Deterministic given the provider.

### 4. `CachedSemanticMatcher implements ISemanticMatcher` — replaces the Noop at the call site
- `constructor(cache: SemanticScoreCache)`; `score(finding, issue)` = sync cache
  lookup → `number | undefined`. Makes no LLM call.

### Gating change — `issue-matcher.ts`
- Add option `semanticThreshold?: number` (τ, default **0.7**).
- New rule (only the line clause changes):
  `matched = fileMatch AND (requireLineOverlap ? (lineOverlap OR semanticPass) : true) AND [cat] AND [sev]`,
  where `semanticPass = semanticScore !== undefined && semanticScore >= τ`.
- Backward compatible: `NoopSemanticMatcher` → `semanticScore` undefined →
  `semanticPass` false → identical to today. `MatchResult.semanticScore` already
  exists and is surfaced.

## Data flow

```
precompute (async, judge, once)  ─writes→  SemanticScoreCache  ─(persist)
        │                                        │
   BenchmarkRun[]                           read (sync)
                                                 ▼
                          GroundTruthEvaluator → IssueMatcher → CachedSemanticMatcher
```

## Judge provider

Reuse `BedrockProvider` with a **non-Anthropic** `modelId` (Llama/Mistral on
Bedrock) — no new SDK/dependency/keys. The concrete model id is a documented
config constant (default a Bedrock Llama id), overridable. Tests use
`MockProvider` returning `{"score": …}` deterministically.

## Testing (`node:test`, MockProvider)

- `parseJudgeScore`: valid, clamped, and malformed → `undefined`.
- `SemanticScoreCache`: set/get, `pairKey` stability, `toJSON/fromJSON` round-trip.
- `JudgeScorePrecomputer`: **only candidate pairs** judged (assert provider call
  count via `onReview`); already-cached pairs skipped; parse-failure leaves no
  entry.
- `CachedSemanticMatcher`: hit → score, miss → `undefined`.
- `IssueMatcher` gating: same-file/wrong-line finding matches when score ≥ τ, not
  when < τ; `NoopSemanticMatcher` path unchanged.
- Integration: `GroundTruthEvaluator` with a pre-populated cache — a wrong-line
  finding that the judge rescues raises recall vs the strict matcher.

## Scope / non-goals

- **This ships:** the four components + the `IssueMatcher` gating + tests.
- **Deferred to pilot (separate, small):** the calibration harness (silver-label
  accuracy, inter-judge Cohen's κ, dual-matcher stability report) and choosing
  the final τ (calibrated on pilot data; default 0.7 until then).
- **Deferred:** wiring the precompute pass into the campaign runner — the
  components are usable via a populated cache; campaign integration rides with
  the calibration work when real data exists.

## Freeze classification

**Evaluation-side.** Operates only on stored findings + ground truth, so it can
land (and τ can be tuned) after data collection and be re-run over stored data
at zero generation cost. Not freeze-critical; the *protocol* is what the
pre-registration fixes (DECISION 4, resolved).
